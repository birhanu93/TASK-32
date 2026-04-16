const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const json = require('koa-json');
const { FIXTURES, authHeader, ROLE_PERMISSIONS } = require('../setup');

function chain(v) {
  const c = new Proxy({}, { get(_, p) {
    if (p === 'then') return (r) => r(v);
    if (p === 'catch' || p === 'finally') return () => c;
    if (p === Symbol.toStringTag) return 'Promise';
    return () => c;
  }});
  return c;
}

function buildApp(db) {
  const connPath = require.resolve('../../src/db/connection');
  const orig = require.cache[connPath];
  require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: db };
  delete require.cache[require.resolve('../../src/routes/campaigns')];
  delete require.cache[require.resolve('../../src/middleware/rbac')];
  delete require.cache[require.resolve('../../src/middleware/audit')];
  const errorHandler = require('../../src/middleware/errorHandler');
  const { auditMiddleware } = require('../../src/middleware/audit');
  const router = require('../../src/routes/campaigns');
  const app = new Koa();
  app.use(errorHandler()); app.use(bodyParser()); app.use(json()); app.use(auditMiddleware());
  app.use(router.routes()); app.use(router.allowedMethods());
  require.cache[connPath] = orig;
  return app;
}

async function req(app, method, path, opts = {}) {
  const server = http.createServer(app.callback());
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const o = { method, headers: { 'Content-Type': 'application/json', ...opts.headers } };
    if (opts.body !== undefined) o.body = JSON.stringify(opts.body);
    const res = await fetch(`http://localhost:${port}${path}`, o);
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, body: data };
  } finally { server.close(); }
}

describe('GET /api/campaigns', () => {
  it('should return 401 without auth', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/campaigns');
    assert.equal(res.status, 401);
  });

  it('should return 403 for Participant (no campaigns.manage)', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/campaigns', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 403);
  });

  it('should return paginated campaigns list for Ops Manager', async () => {
    const campaigns = [
      { id: 'cam1', name: 'Summer Sale', status: 'active' },
      { id: 'cam2', name: 'Winter Promo', status: 'draft' },
    ];
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS['Operations Manager']);
      if (t === 'campaigns') return chain([{ count: '2' }]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/campaigns', {
      headers: { Authorization: authHeader(FIXTURES.opsUser) },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.data !== undefined, 'Response should contain data');
    assert.ok(res.body.pagination !== undefined, 'Response should contain pagination');
    assert.equal(res.body.pagination.page, 1);
    assert.equal(res.body.pagination.per_page, 20);
  });
});

describe('GET /api/campaigns/:id', () => {
  it('should return 401 without auth', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/campaigns/cam1');
    assert.equal(res.status, 401);
  });

  it('should return 404 for non-existent campaign', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'campaigns') return chain(null);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/campaigns/fake', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 404);
  });

  it('should return campaign with placements and coupons', async () => {
    const campaign = { id: 'cam1', name: 'Summer Sale', status: 'active' };
    const placements = [{ id: 'pl1', campaign_id: 'cam1', slot: 'homepage_banner' }];
    const coupons = [{ id: 'cp1', campaign_id: 'cam1', code: 'SUMMER10' }];
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'campaigns') return chain(campaign);
      if (t === 'placements') return chain(placements);
      if (t === 'coupons') return chain(coupons);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/campaigns/cam1', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, 'cam1');
    assert.equal(res.body.name, 'Summer Sale');
    assert.ok(Array.isArray(res.body.placements), 'Should include placements');
    assert.equal(res.body.placements[0].slot, 'homepage_banner');
    assert.ok(Array.isArray(res.body.coupons), 'Should include coupons');
    assert.equal(res.body.coupons[0].code, 'SUMMER10');
  });
});

describe('GET /api/campaigns/:id/ab-assignment', () => {
  it('should return 401 without auth', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/campaigns/cam1/ab-assignment');
    assert.equal(res.status, 401);
  });

  it('should return 404 for non-existent campaign', async () => {
    const db = (t) => chain(null);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/campaigns/fake/ab-assignment', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 404);
  });

  it('should return 400 when campaign has no A/B test', async () => {
    const campaign = { id: 'cam1', name: 'No AB', ab_test_id: null };
    const db = (t) => chain(campaign);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/campaigns/cam1/ab-assignment', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('A/B test'));
  });

  it('should return variant assignment for valid A/B campaign', async () => {
    const campaign = {
      id: 'cam1', name: 'AB Test', ab_test_id: 'test-1',
      ab_variants: [{ name: 'control', weight: 0.5 }, { name: 'variant_a', weight: 0.5 }],
      current_rollout_percent: 100,
    };
    const db = (t) => chain(campaign);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/campaigns/cam1/ab-assignment', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.variant !== undefined, 'Response should include variant');
    assert.equal(res.body.test_id, 'test-1');
    assert.ok(['control', 'variant_a'].includes(res.body.variant), 'Variant should be one of the configured options');
  });
});

describe('POST /api/campaigns/:id/placements', () => {
  it('should return 401 without auth', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns/cam1/placements', {
      body: { slot: 'banner' },
    });
    assert.equal(res.status, 401);
  });

  it('should return 400 without slot', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns/cam1/placements', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: {},
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('slot'));
  });

  it('should create placement with all fields', async () => {
    const placement = { id: 'pl1', campaign_id: 'cam1', slot: 'homepage_banner', priority: 5, content: '{"text":"hello"}' };
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'placements') return chain([placement]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns/cam1/placements', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { slot: 'homepage_banner', content: { text: 'hello' }, priority: 5 },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.id, 'pl1');
    assert.equal(res.body.slot, 'homepage_banner');
    assert.equal(res.body.priority, 5);
    assert.equal(res.body.campaign_id, 'cam1');
  });
});

describe('GET /api/campaigns/placements/active', () => {
  it('should return 401 without auth', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/campaigns/placements/active?slot=banner');
    assert.equal(res.status, 401);
  });

  it('should return 400 without slot query param', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/campaigns/placements/active', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('slot'));
  });

  it('should return active placements for a given slot', async () => {
    const placements = [
      { id: 'pl1', slot: 'homepage_banner', priority: 10, campaign_id: 'cam1' },
    ];
    const db = (t) => {
      if (t === 'placements') return chain(placements);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/campaigns/placements/active?slot=homepage_banner', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body), 'Response should be an array');
  });
});

describe('GET /api/campaigns/analytics/ab-test/:testId', () => {
  it('should return 401 without auth', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/campaigns/analytics/ab-test/test-1');
    assert.equal(res.status, 401);
  });

  it('should return 403 for Participant (no campaigns.analytics)', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/campaigns/analytics/ab-test/test-1', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 403);
  });

  it('should return A/B test results grouped by variant', async () => {
    const events = [
      { ab_variant: 'control', event_type: 'click', count: '10', unique_users: '5' },
      { ab_variant: 'variant_a', event_type: 'click', count: '15', unique_users: '8' },
    ];
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'analytics_events') return chain(events);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/campaigns/analytics/ab-test/test-1', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.test_id, 'test-1');
    assert.ok(res.body.variants !== undefined, 'Response should contain variants');
    assert.ok(res.body.variants.control !== undefined, 'Should have control variant');
    assert.ok(res.body.variants.variant_a !== undefined, 'Should have variant_a');
    assert.equal(res.body.variants.control.click.count, 10);
    assert.equal(res.body.variants.control.click.unique_users, 5);
    assert.equal(res.body.variants.variant_a.click.count, 15);
    assert.equal(res.body.variants.variant_a.click.unique_users, 8);
  });
});

describe('POST /api/campaigns', () => {
  it('should return 400 without name and include error message', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: {},
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error, 'Response should contain error');
    assert.ok(res.body.error.message.includes('name'), 'Error should mention missing name');
  });

  it('should create campaign', async () => {
    const campaign = { id: 'cam1', name: 'Summer Sale', status: 'draft' };
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS['Operations Manager']);
      if (t === 'campaigns') return chain([campaign]);
      if (t === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns', {
      headers: { Authorization: authHeader(FIXTURES.opsUser) },
      body: { name: 'Summer Sale' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Summer Sale');
  });
});

describe('PUT /api/campaigns/:id rollout phase validation', () => {
  it('should reject invalid rollout phase values on update', async () => {
    const existing = { id: 'cam1', name: 'Existing', status: 'draft', rollout_phases: null, start_at: null, end_at: null };
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'campaigns') return chain(existing);
      if (t === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'PUT', '/api/campaigns/cam1', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { rollout_phases: [{ percent: 10 }, { percent: 50 }, { percent: 100 }] },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('Invalid rollout phase 10%'));
  });

  it('should reject rollout phases not ending at 100 on update', async () => {
    const existing = { id: 'cam1', name: 'Existing', status: 'draft', start_at: null, end_at: null };
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'campaigns') return chain(existing);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'PUT', '/api/campaigns/cam1', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { rollout_phases: [{ percent: 5 }, { percent: 25 }, { percent: 50 }] },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('must end at 100%'));
  });

  it('should reject non-ascending rollout phases on update', async () => {
    const existing = { id: 'cam1', name: 'Existing', status: 'draft', start_at: null, end_at: null };
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'campaigns') return chain(existing);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'PUT', '/api/campaigns/cam1', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { rollout_phases: [{ percent: 100 }, { percent: 50 }, { percent: 25 }, { percent: 5 }] },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('strictly ascending'));
  });

  it('should accept valid rollout phases on update', async () => {
    const existing = { id: 'cam1', name: 'Existing', status: 'draft', start_at: null, end_at: null };
    const updated = { ...existing, rollout_phases: [{ percent: 5 }, { percent: 25 }, { percent: 50 }, { percent: 100 }] };
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'campaigns') return chain([updated]); // first call returns existing, update returns updated
      if (t === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'PUT', '/api/campaigns/cam1', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { rollout_phases: [{ percent: 5 }, { percent: 25 }, { percent: 50 }, { percent: 100 }] },
    });
    assert.equal(res.status, 200);
  });
});

describe('POST /api/campaigns/coupons', () => {
  it('should return 400 without required fields', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns/coupons', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { code: 'TEST' },
    });
    assert.equal(res.status, 400);
  });

  it('should return 400 for fixed discount out of range', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns/coupons', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { code: 'BIG', discount_type: 'fixed', discount_value: 100 },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('$5'));
  });

  it('should return 400 for percent discount out of range', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns/coupons', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { code: 'BIG', discount_type: 'percent', discount_value: 50 },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('5%'));
  });
});

describe('POST /api/campaigns/coupons/validate', () => {
  it('should return 400 without code', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns/coupons/validate', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: {},
    });
    assert.equal(res.status, 400);
  });

  it('should return invalid for non-existent coupon', async () => {
    const db = (t) => chain(null);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns/coupons/validate', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { code: 'NOPE' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.valid, false);
  });
});

describe('POST /api/campaigns/events', () => {
  it('should return 400 without required fields', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns/events', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { idempotency_key: 'k1' },
    });
    assert.equal(res.status, 400);
  });

  it('should return duplicate for existing idempotency key', async () => {
    const existing = { id: 'e1', idempotency_key: 'k1', event_type: 'click' };
    const db = (t) => chain(existing);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns/events', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { idempotency_key: 'k1', event_type: 'click' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'duplicate');
  });
});

describe('GET /api/campaigns/analytics/funnel', () => {
  it('should return 400 without funnel_name', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/campaigns/analytics/funnel', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 400);
  });
});
