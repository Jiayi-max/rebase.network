import { expect, request as playwrightRequest, test } from '@playwright/test';
import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://rebase:rebase@127.0.0.1:55433/rebase';
const smokeApiPort = Number.parseInt(process.env.SMOKE_API_PORT || '8789', 10);
const smokeApiBaseUrl = `http://127.0.0.1:${smokeApiPort}`;

test('Rebase article moves from private draft to public indexed content', async ({ request }) => {
  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const slug = `rebase-publication-smoke-${uniqueId}`;
  const title = `Rebase 发布流程测试 ${uniqueId}`;
  const seoTitle = `Rebase 文章发布测试 | ${uniqueId}`;
  const seoDescription = '验证 Rebase 草稿、发布、结构化数据、RSS 与 sitemap 的完整内容链路。';
  const bodyMarkdown = '## Rebase 发布验证\n\n这是一条仅在本地 smoke 环境运行的 Rebase 内容发布测试。';
  const adminApi = await playwrightRequest.newContext({ baseURL: smokeApiBaseUrl });
  const client = new Client({ connectionString: databaseUrl });

  await client.connect();

  try {
    const signInResponse = await adminApi.post('/api/auth/sign-in/email', {
      data: {
        email: process.env.DEV_ADMIN_EMAIL ?? 'admin@rebase.local',
        password: process.env.DEV_ADMIN_PASSWORD ?? 'RebaseAdmin123456!',
      },
    });
    expect(signInResponse.ok()).toBeTruthy();

    const createResponse = await adminApi.post('/api/admin/v1/articles', {
      data: {
        slug,
        title,
        summary: '验证 Rebase 文章从草稿进入公开索引输出的全过程。',
        bodyMarkdown,
        readingTime: '3 min read',
        coverAssetId: null,
        coverAccent: 'linear-gradient(135deg, #efc37b 0%, #0f766e 100%)',
        authors: [{ name: 'Rebase Smoke Test' }],
        tags: ['rebase', 'publication-test'],
        seoTitle,
        seoDescription,
        status: 'draft',
        publishedAt: null,
      },
    });
    expect(createResponse.status()).toBe(201);

    const createPayload = await createResponse.json();
    const article = createPayload.data as { id: string; publicNumber: number; status: string };
    const articlePath = `/articles/${article.publicNumber}-${slug}`;
    expect(article.status).toBe('draft');

    const draftPageResponse = await request.get(articlePath);
    expect(draftPageResponse.status()).toBe(404);

    const draftListResponse = await request.get('/articles');
    expect(await draftListResponse.text()).not.toContain(title);

    const draftSitemapResponse = await request.get('/sitemap.xml');
    expect(await draftSitemapResponse.text()).not.toContain(slug);

    const publishResponse = await adminApi.post(`/api/admin/v1/articles/${article.id}/publish`);
    expect(publishResponse.ok()).toBeTruthy();
    const publishPayload = await publishResponse.json();
    expect(publishPayload.data.status).toBe('published');
    expect(publishPayload.data.publishedAt).toBeTruthy();

    const publishedPageResponse = await request.get(`${articlePath}?publication=${uniqueId}`);
    expect(publishedPageResponse.ok()).toBeTruthy();
    const publishedBody = await publishedPageResponse.text();
    expect(publishedBody).toContain(title);
    expect(publishedBody).toContain('Rebase 发布验证');
    expect(publishedBody).toContain(`<title>${seoTitle}</title>`);
    expect(publishedBody).toContain(`content="${seoDescription}"`);
    expect(publishedBody).toContain('"@type":"Article"');
    expect(publishedBody).toContain(`"@id":"https://rebase.network${articlePath}"`);

    const publishedListResponse = await request.get(`/articles?publication=${uniqueId}`);
    expect(await publishedListResponse.text()).toContain(title);

    const publishedFeedResponse = await request.get(`/articles/rss.xml?publication=${uniqueId}`);
    const publishedFeed = await publishedFeedResponse.text();
    expect(publishedFeed).toContain(title);
    expect(publishedFeed).toContain(`https://rebase.network${articlePath}`);

    const publishedSitemapResponse = await request.get(`/sitemap.xml?publication=${uniqueId}`);
    const publishedSitemap = await publishedSitemapResponse.text();
    expect(publishedSitemap).toContain(`https://rebase.network${articlePath}`);
    expect(publishedSitemap).toMatch(new RegExp(`${slug}<\\/loc><lastmod>[^<]+<\\/lastmod>`));
  } finally {
    await client.query('delete from articles where slug = $1', [slug]);
    await client.end();
    await adminApi.dispose();
  }
});
