const validate = require('../../ipld-schema-validation')(require('./schema.json'))
const fromBlock = (block, className) => validate(block.decode(), className)
const hamt = require('./hamt')
const isCID = require('./is-cid')

const readonly = (source, key, value) => {
  Object.defineProperty(source, key, { value, writable: false })
}

const noResolver = () => {
  throw new Error('Operation conflict and no resolver has been provided')
}

class NotFound extends Error {
  get status () {
    return 404
  }

  get kvs () {
    return 'notfound'
  }
}

const createGet = (local, remote) => {
  const cache = new Map()
  const _cache = (key, block) => cache.set(key, block)
  const get = async cid => {
    const key = cid.toString('base64')
    if (cache.has(key)) return cache.get(key)
    let ret
    try {
      ret = await local.get(cid)
    } catch (e) {
      // noop
    }
    if (ret) {
      _cache(await ret.cid(), ret)
      return ret
    }
    if (cache.has(key)) return cache.get(key)
    const block = await remote.get(cid)
    local.put(block)
    _cache(key, block)
    return block
  }
  return get
}

module.exports = (Block, codec = 'dag-cbor') => {
  const toBlock = (value, className) => Block.encoder(validate(value, className), codec)

  const commitKeyValueTransaction = async function * (_ops, root, get, conflictResolver = noResolver) {
    const rootBlock = await get(root)
    const kvt = validate(rootBlock.decode(), 'Transaction')
    const blocks = (await Promise.all(_ops.map(async o => {
      if (Block.isBlock(o)) return o
      if (o.set) o.set.val = await o.set.val
      return toBlock(o, 'Operation')
    })))
    const seen = new Set()
    const keyMap = new Map()
    // hash in parallel
    await Promise.all(blocks.map(b => b.cid()))
    for (const block of blocks) {
      const cid = await block.cid()
      const cidString = cid.toString('base64')

      // remove duplicate ops
      if (seen.has(cidString)) continue
      else seen.add(cidString)

      // resole any conflicts over the same key
      const op = block.decodeUnsafe()
      const key = op[Object.keys(op)[0]].key
      if (keyMap.has(key)) {
        keyMap.set(key, conflictResolver(keyMap.get(key), block))
      } else {
        keyMap.set(key, block)
      }
    }

    const head = kvt.v1.head

    let last
    for await (const block of hamt.bulk(Block, get, head, keyMap.values(), codec)) {
      last = block
      yield block
    }
    const ops = await Promise.all(Array.from(keyMap.values()).map(block => block.cid()))
    yield toBlock({ v1: { head: await last.cid(), ops, prev: await rootBlock.cid() } }, 'Transaction')
  }

  const isBlock = v => Block.isBlock(v)

  class Transaction {
    constructor () {
      this.ops = []
    }

    set (key, block) {
      const val = block.cid()
      this.ops.push({ set: { key, val } })
    }

    del (key) {
      this.ops.push({ del: { key } })
    }
  }

  class KeyValueTransaction {
    constructor (root, store) {
      readonly(this, 'root', root)
      this.rootTransaction = store.get(root).then(block => {
        return fromBlock(block, 'Transaction')
      })
      this.store = store
      this.cache = { set: {}, del: new Set(), pending: [] }
    }

    set (key, block) {
      if (this.spent) throw new Error('Transaction already commited')
      if (!isBlock(block)) block = Block.encoder(block, codec)
      if (this.cache.del.has(key)) this.del.remove(key)
      this.cache.set[key] = block
      this.cache.pending.push(this.store.put(block))
    }

    del (key) {
      if (this.spent) throw new Error('Transaction already commited')
      if (this.cache.set[key]) delete this.cache.set[key]
      this.cache.del.add(key)
    }

    commit () {
      if (this.spent) return this.spent
      readonly(this, 'spent', this._commit())
      return this.spent
    }

    async _commit () {
      const trans = new Transaction()
      for (const [key, block] of Object.entries(this.cache.set)) {
        trans.set(key, block)
      }
      for (const key of this.cache.del) {
        trans.del(key)
      }
      const root = this.root
      const _commit = commitKeyValueTransaction(trans.ops, root, this.store.get.bind(this.store))
      const promises = []
      let last
      for await (const block of _commit) {
        last = block
        promises.push(this.store.put(block))
      }
      await Promise.all([...this.cache.pending, ...promises])
      return last.cid()
    }

    _get (key) {
      // Check cache
      if (this.cache.set[key]) return this.cache.set[key].decode()
      if (this.cache.del.has(key)) throw new NotFound(`No key named "${key}"`)
    }

    async get (key) {
      if (this._get(key)) return this._get(key)
      const root = await this.store.get(this.root)
      const head = root.decode().v1.head
      const link = await hamt.get(head, key, this.store.get.bind(this.store))
      if (!link) throw new NotFound(`No key named "${key}"`)
      const block = await this.store.get(link)

      // one last cache check since there was async work
      if (this._get(key)) return this._get(key).decode()

      return block.decode()
    }
  }

  const dedupe = async (oldOps, newOps) => {
    const ops = []
    const seen = new Set()
    const blocks = oldOps.concat(newOps)
    const keys = await Promise.all(blocks.map(b => b.cid()))
    for (const block of blocks) {
      const key = keys.shift().toString('base64')
      if (seen.has(key)) continue
      seen.add(key)
      ops.push(block.decodeUnsafe())
    }
    return ops
  }

  const replicate = async (oldRoot, newRoot, local, remote, reconcile = dedupe, conflictResolve = noResolver) => {
    // pushes newRoot (source) to destination's oldRoot
    const get = createGet(local, remote)

    if (isCID(oldRoot)) oldRoot = await get(oldRoot)
    if (isCID(newRoot)) newRoot = await get(newRoot)
    const seen = new Set()

    const find = root => {
      const decoded = root.decodeUnsafe()
      const key = decoded.head.toString('base64')
      if (seen.has(key)) return decoded.head
      seen.add(key)
      return get(decoded.prev).then(block => find(block))
    }

    const common = await Promise.race([find(oldRoot), find(newRoot)])

    const since = async (trans, head, ops = []) => {
      const decoded = trans.decodeUnsafe()
      if (decoded.head.equals(head)) return ops
      ops.push(decoded.ops.map(op => get(op)))
      const prev = await get(decoded.prev)
      return since(prev, head, ops)
    }

    const [oldOps, newOps] = await Promise.all([since(oldRoot, common), since(newRoot, common)])

    // TODO: remove older mutations on the same key from the each op set
    throw new Error('unfinished')
  }

  const emptyHamt = hamt.empty(Block, codec)
  const emptyData = async () => ({ v1: { head: await emptyHamt.cid(), ops: [], prev: null } })
  const empty = (async () => toBlock(await emptyData(), 'Transaction'))()

  const KVT = KeyValueTransaction
  const exports = (...args) => new KVT(...args)
  exports.create = async store => {
    const _empty = await empty
    await Promise.all([store.put(_empty), store.put(emptyHamt)])
    const root = await _empty.cid()
    return new KeyValueTransaction(root, store)
  }
  exports.transaction = (root, store) => new KVT(root, store)
  return exports
}
