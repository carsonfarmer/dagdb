const jsonHeaders = body => {
  return { 'content-length': body.length, 'content-type': 'application/json' }
}

const blockstore = (Block, store) => {
  const { CID } = Block
  const handler = async opts => {
    let { method, path, params, body } = opts
    if (!method) throw new Error('Missing required param "method"')
    if (!path) throw new Error('Missing required param "path"')
    while (path[0] === '/') path = path.slice(1)
    if (method === 'PUT' && !body) {
      throw new Error('Missing required param "body"')
    }
    if (method === 'GET') {
      if (path.includes('/graph')) {
        const [key] = path.split('/')
        let { depth } = params
        if (typeof depth !== 'undefined') {
          if (depth > store.depthLimit) throw new Error(`Depth is greater than max limit of ${store.depthLimit}`)
        } else {
          depth = store.depthLimit
        }
        const result = await store.graph(CID.from(key), depth)
        if (result.missing) result.missing = Array.from(result.missing)
        if (result.incomplete) result.incomplete = Array.from(result.incomplete)
        const body = Buffer.from(JSON.stringify({ result, depth }))
        return { headers: jsonHeaders(body), body }
      } else {
        if (path.includes('/')) throw new Error('Path for block retreival must not include slashes')
        const cid = CID.from(path)
        let block
        try {
          block = await store.get(cid)
        } catch (e) {
          // we don't have intentional errors in our own cod
          if (e.statusCode === 404) return { statusCode: 404 } /* c8 ignore next */
          /* c8 ignore next */
          throw e
          /* c8 ignore next */
        }
        const body = block.encodeUnsafe()
        return { headers: { 'content-length': body.length }, body }
      }
    } else if (method === 'PUT') {
      if (path.includes('/')) throw new Error('Path for block writes must not include slashes')
      const cid = CID.from(path)
      const block = Block.create(body, cid)
      await block.validate()
      await store.put(block)
      return { statusCode: 201 }
    } else if (method === 'HEAD') {
      if (path.includes('/')) throw new Error('Path for block retreival must not include slashes')
      const cid = CID.from(path)
      const has = await store.has(cid)
      if (!has) return { statusCode: 404 }
      if (has.length) return { headers: { 'content-length': has.length } }
      return { statusCode: 200 }
    } else {
      const e = new Error(`Unknown method "${method}"`)
      e.statusCode = 405
      throw e
    } /* c8 ignore next */
  }
  return handler
}

const info = (store, updater, ext) => async opts => {
  const root = await updater.root
  const info = {
    root: root ? root.toString('base32') : root,
    blockstore: 'blockstore'
  }
  if (updater.update) info.updater = 'updater'
  const body = Buffer.from(JSON.stringify({ ...info, ...ext }))
  const ret = { headers: jsonHeaders(body), body }
  return ret
}

const updater = (Block, updater) => async opts => {
  const { CID } = Block
  if (!opts.params.new) throw new Error('Missing required param "new"')
  opts.params.new = CID.from(opts.params.new)
  if (opts.params.old) opts.params.old = CID.from(opts.params.old)
  const cid = await updater.update(opts.params.new, opts.params.old)
  const body = Buffer.from(JSON.stringify({ root: cid.toString('base32') }))
  const ret = { headers: jsonHeaders(body), body }
  return ret
}
export { blockstore, info, updater }
