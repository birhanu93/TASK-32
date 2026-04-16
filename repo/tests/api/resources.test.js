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
  delete require.cache[require.resolve('../../src/routes/resources')];
  delete require.cache[require.resolve('../../src/middleware/rbac')];
  delete require.cache[require.resolve('../../src/middleware/audit')];
  const errorHandler = require('../../src/middleware/errorHandler');
  const { auditMiddleware } = require('../../src/middleware/audit');
  const router = require('../../src/routes/resources');
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

describe('GET /api/resources', () => {
  it('should return resource list with pagination', async () => {
    const db = (t) => chain([{ count: '0' }]);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/resources', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.data !== undefined, 'Response should contain data');
    assert.ok(res.body.pagination !== undefined, 'Response should contain pagination');
    assert.equal(res.body.pagination.page, 1);
    assert.equal(typeof res.body.pagination.total, 'number');
  });
});

describe('GET /api/resources/:id', () => {
  it('should return 401 without auth', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/resources/r1');
    assert.equal(res.status, 401);
  });

  it('should return 403 when non-admin has no ACL access', async () => {
    const db = (t) => {
      if (t === 'resources') return chain(null);
      if (t === 'user_roles') return chain([]);
      if (t === 'roles') return chain(null);
      if (t === 'acl_entries') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/resources/fake', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 403);
    assert.ok(res.body.error.message.includes('read'), 'Error should mention denied read access');
  });

  it('should return 404 for non-existent resource when admin has access', async () => {
    const db = (t) => {
      if (t === 'resources') return chain(null);
      if (t === 'user_roles') return chain(['role-admin']);
      if (t === 'roles') return chain({ id: 'role-admin', name: 'Administrator' });
      if (t === 'acl_entries') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/resources/fake', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 404);
  });

  it('should return resource with ACL entries', async () => {
    const resource = { id: 'r1', type: 'folder', name: 'Docs', owner_id: FIXTURES.adminUser.id };
    const acls = [
      { id: 'acl1', resource_id: 'r1', user_id: 'u1', action: 'read', effect: 'allow' },
      { id: 'acl2', resource_id: 'r1', role_id: 'role1', action: 'edit', effect: 'deny' },
    ];
    const db = (t) => {
      if (t === 'resources') return chain(resource);
      if (t === 'user_roles') return chain(['role-admin']);
      if (t === 'roles') return chain({ id: 'role-admin', name: 'Administrator' });
      if (t === 'acl_entries') return chain(acls);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/resources/r1', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, 'r1');
    assert.equal(res.body.name, 'Docs');
    assert.equal(res.body.type, 'folder');
    assert.ok(Array.isArray(res.body.acl), 'Response should include acl array');
    assert.equal(res.body.acl.length, 2);
    assert.equal(res.body.acl[0].action, 'read');
    assert.equal(res.body.acl[0].effect, 'allow');
    assert.equal(res.body.acl[1].action, 'edit');
    assert.equal(res.body.acl[1].effect, 'deny');
  });
});

describe('DELETE /api/resources/:id', () => {
  it('should return 401 without auth', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'DELETE', '/api/resources/r1');
    assert.equal(res.status, 401);
  });

  it('should return 404 for non-existent resource (admin bypasses ACL)', async () => {
    const db = (t) => {
      if (t === 'resources') return chain(null);
      if (t === 'user_roles') return chain(['role-admin']);
      if (t === 'roles') return chain({ id: 'role-admin', name: 'Administrator' });
      if (t === 'acl_entries') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'DELETE', '/api/resources/fake', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 404);
  });

  it('should delete resource and return 204', async () => {
    const resource = { id: 'r1', type: 'folder', name: 'Docs', owner_id: FIXTURES.adminUser.id };
    const db = (t) => {
      if (t === 'resources') return chain(resource);
      if (t === 'user_roles') return chain(['role-admin']);
      if (t === 'roles') return chain({ id: 'role-admin', name: 'Administrator' });
      if (t === 'acl_entries') return chain([]);
      if (t === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'DELETE', '/api/resources/r1', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 204);
  });
});

describe('DELETE /api/resources/:resourceId/acl/:aclId', () => {
  it('should return 401 without auth', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'DELETE', '/api/resources/r1/acl/acl1');
    assert.equal(res.status, 401);
  });

  it('should return 403 for Participant (no resources.manage_acl)', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'DELETE', '/api/resources/r1/acl/acl1', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 403);
  });

  it('should return 404 for non-existent ACL entry', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'acl_entries') return chain(null);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'DELETE', '/api/resources/r1/acl/fake', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 404);
  });

  it('should delete ACL entry and return 204', async () => {
    const entry = { id: 'acl1', resource_id: 'r1', user_id: 'u1', action: 'read', effect: 'allow' };
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'acl_entries') return chain(entry);
      if (t === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'DELETE', '/api/resources/r1/acl/acl1', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 204);
  });
});

describe('POST /api/resources/:id/acl/propagate', () => {
  it('should return 401 without auth', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/resources/r1/acl/propagate');
    assert.equal(res.status, 401);
  });

  it('should return 403 for Participant (no resources.manage_acl)', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/resources/r1/acl/propagate', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 403);
  });

  it('should return 404 for non-existent resource', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'resources') return chain(null);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/resources/fake/acl/propagate', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 404);
  });

  it('should propagate ACL to children and return count', async () => {
    const resource = { id: 'r1', type: 'folder', name: 'Parent' };
    const children = [
      { id: 'r2', type: 'file', name: 'Child1', parent_id: 'r1' },
      { id: 'r3', type: 'file', name: 'Child2', parent_id: 'r1' },
    ];
    const parentAcls = [
      { id: 'acl1', resource_id: 'r1', user_id: 'u1', action: 'read', effect: 'allow' },
    ];
    let callIdx = 0;
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'resources') {
        callIdx++;
        if (callIdx === 1) return chain(resource); // .first() for parent lookup
        return chain(children); // children query
      }
      if (t === 'acl_entries') return chain(parentAcls);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/resources/r1/acl/propagate', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.message.includes('children'), 'Response should mention children');
    assert.ok(res.body.entries_created !== undefined, 'Should include entries_created count');
  });
});

describe('POST /api/resources', () => {
  it('should return 400 without type/name', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/resources', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { type: 'folder' },
    });
    assert.equal(res.status, 400);
  });

  it('should create resource', async () => {
    const resource = { id: 'r1', type: 'folder', name: 'Docs', owner_id: FIXTURES.participantUser.id };
    const db = (t) => {
      if (t === 'resources') return chain([resource]);
      if (t === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/resources', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { type: 'folder', name: 'Docs' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Docs');
  });
});

describe('POST /api/resources/:id/acl', () => {
  it('should return 400 without action', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/resources/r1/acl', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { user_id: 'u1' },
    });
    assert.equal(res.status, 400);
  });

  it('should return 400 without user_id or role_id', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/resources/r1/acl', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { action: 'read' },
    });
    assert.equal(res.status, 400);
  });

  it('should return 400 for invalid action', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/resources/r1/acl', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { user_id: 'u1', action: 'fly' },
    });
    assert.equal(res.status, 400);
  });

  it('should create ACL entry', async () => {
    const entry = { id: 'acl1', resource_id: 'r1', user_id: 'u1', action: 'read', effect: 'allow' };
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'acl_entries') return chain([entry]);
      if (t === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/resources/r1/acl', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { user_id: 'u1', action: 'read' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.action, 'read');
  });
});
