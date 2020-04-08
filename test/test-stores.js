/* globals describe, it, before, after */
const { fixtures, graphTests, replicateTests, basics } = require('./lib/storage')
const Block = require('@ipld/block')
const assert = require('assert')
const same = assert.deepStrictEqual
const inmem = require('../src/store/inmemory')
const test = it

const b = obj => Block.encoder(obj, 'dag-cbor')

describe('inmem', () => {
  test('basic inmem', async () => {
    await basics(inmem)
  })
  test('store block twice', async () => {
    const store = await inmem()
    const block = b({ hello: 'world' })
    await store.put(block)
    await store.put(block)
    same(store.storage.size, 1)
  })
  describe('graph', () => {
    graphTests(inmem, (store, ...args) => store.graph(...args))

    test('depth 0', async () => {
      const store = await inmem()
      const blocks = await fixtures.commonBranches()
      const branches = blocks.slice(1, 3)
      await Promise.all(blocks.map(b => store.put(b)))
      const [root] = blocks
      var { complete, missing, incomplete } = await store.graph(await root.cid(), 0)
      assert.ok(!complete)
      assert.ok(!missing)
      assert.ok(incomplete)
      same(incomplete.size, 2)
      for (const block of branches) {
        const cid = await block.cid()
        assert.ok(incomplete.has(cid.toString('base32')))
      }
      // cause a full traversal
      await store.graph(await root.cid())
      // the full traversal should update the competion cache
      const r = await store.graph(await root.cid(), 0)
      assert.ok(r.complete && !r.missing && !r.incomplete)
    })
  })
  describe('replicate', () => {
    replicateTests(inmem)
  })
})

describe('kv', () => {
  const create = require('./lib/mock-kv')
  test('basics', async () => {
    await basics(create)
  })
  test('store block twice', async () => {
    const store = await create()
    const block = b({ hello: 'world' })
    await store.put(block)
    same(Object.keys(store.storage).length, 2)
    await store.put(block)
    same(Object.keys(store.storage).length, 2)
  })
  describe('graph', () => {
    graphTests(create, (store, ...args) => store.graph(...args))
  })
  describe('replicate', () => {
    replicateTests(create)
  })
})

describe('s3', () => {
  const createS3 = require('./lib/mock-s3')
  const createStore = require('../src/store/s3')(Block)
  const create = () => createStore(createS3())
  test('basics', async () => {
    await basics(create)
  })
  test('store block twice', async () => {
    const store = await create()
    const block = b({ hello: 'world' })
    await store.put(block)
    same(Object.keys(store.s3.storage).length, 2)
    await store.put(block)
    same(Object.keys(store.s3.storage).length, 2)
  })
  describe('graph', () => {
    graphTests(create, (store, ...args) => store.graph(...args))
  })
  describe('replicate', () => {
    replicateTests(create)
  })
})

describe('level', () => {
  const memdown = require('memdown')
  const createStore = require('../src/store/level')(Block)
  const create = () => createStore(memdown(Math.random().toString()))
  test('basics', async () => {
    await basics(create)
  })
  describe('graph', () => {
    graphTests(create, (store, ...args) => store.graph(...args))
  })
  describe('replicate', () => {
    replicateTests(create)
  })
})

if (!process.browser) {
  const getPort = () => Math.floor(Math.random() * (9000 - 8000) + 8000)
  const stores = {}

  const createNodejsHandler = require('../src/http/store/nodejs')

  const handler = async (req, res) => {
    const parsed = new URL('http://asdf' + req.url)
    const id = parsed.searchParams.get('id')
    parsed.searchParams.delete('id')
    const store = stores[id]
    if (!store) throw new Error('Missing store')
    req.url = parsed.toString().slice('http://asdf'.length)
    const _handler = createNodejsHandler(Block, store)
    return _handler(req, res)
  }

  describe('http', () => {
    const port = getPort()
    const server = require('http').createServer(handler)
    const closed = new Promise(resolve => server.once('close', resolve))
    before(() => new Promise((resolve, reject) => {
      server.listen(port, e => {
        if (e) return reject(e)
        resolve()
      })
    }))
    const createStore = require('../src/store/https')(Block)
    const create = () => {
      const id = Math.random().toString()
      const url = `http://localhost:${port}?id=${id}`
      stores[id] = inmem()
      const store = createStore(url)
      return store
    }
    test('basics', async () => {
      await basics(create)
    })
    describe('store.graph()', () => {
      graphTests(create, (store, ...args) => store.graph(...args))
    })
    describe('replicate', () => {
      replicateTests(create)
    })
    after(() => {
      server.close()
      return closed
    })
  })
  describe('http no params', () => {
    const port = getPort()
    const store = inmem()
    const server = require('http').createServer(createNodejsHandler(Block, store))
    const closed = new Promise(resolve => server.once('close', resolve))
    before(() => new Promise((resolve, reject) => {
      server.listen(port, e => {
        if (e) return reject(e)
        resolve()
      })
    }))
    const createStore = require('../src/store/https')(Block)
    const create = () => {
      const url = `http://localhost:${port}`
      return createStore(url)
    }
    test('basics', async () => {
      await basics(create)
    })
    test('url making', done => {
      const store = create()
      same(store.mkurl('asdf'), `http://localhost:${port}/asdf`)
      store.url += '/'
      same(store.mkurl('asdf'), `http://localhost:${port}/asdf`)
      done()
    })
    after(() => {
      server.close()
      return closed
    })
  })
  describe('http handler', () => {
    const createHandler = require('../src/http/store/handler')
    test('head', async () => {
      const store = inmem()
      const handler = createHandler(Block, store)
      const block = Block.encoder(Buffer.from('test'), 'raw')
      await store.put(block)
      const cid = await block.cid()
      const opts = { method: 'HEAD', path: cid.toString('base32') }
      let result = await handler(opts)
      same(result.headers['content-length'], 4)
      store.has = async () => true
      result = await handler(opts)
      same(result.statusCode, 200)
    })
  })
} else {
  describe('idb', () => {
    const idb = require('level-js')
    const createStore = require('../src/store/level')(Block)
    const create = () => createStore(idb(Math.random().toString()))
    test('basics', async () => {
      await basics(create)
    })
    describe('graph', () => {
      graphTests(create, (store, ...args) => store.graph(...args))
    })
    describe('replicate', () => {
      replicateTests(create)
    })
  })
}
