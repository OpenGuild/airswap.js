const ethers = require('ethers')
const WebSocket = require('isomorphic-ws')
const uuid = require('uuid4')
const { REACT_APP_SERVER_URL, INDEXER_ADDRESS } = require('../constants')

const TIMEOUT = 12000

// Class Constructor
// ----------------
class Messenger {
  // * `privateKey`: `string` - ethereum private key with `"0x"` prepended
  // * `infuraKey`: `string` - infura API key
  // * `nodeAddress`: `string` - optionally specify a geth/parity node instead of using infura
  // * `rpcActions`: `Object` - user defined methods; called by peers via JSON-RPC
  // * `networkId`: `string` - which ethereum network is used; `'rinkeby'` or `'mainnet'`
  constructor(config) {
    const { rpcActions = {}, messageSigner, address, keyspace } = config

    // Create an ethereum wallet object for signing orders
    this.messageSigner = messageSigner
    this.address = address

    // Set the websocket url based on environment
    this.socketUrl = `wss:${REACT_APP_SERVER_URL}websocket${
      keyspace ? `?use_pgp=true&address=${address.toLowerCase()}` : ''
    }`

    // Websocket authentication state
    this.isAuthenticated = false

    // Promise resolvers/rejectors and timeouts for each call
    this.RESOLVERS = {}
    this.REJECTORS = {}
    this.TIMEOUTS = {}

    // User defined methods that will be invoked by peers on the JSON-RPC
    this.RPC_METHOD_ACTIONS = rpcActions

    this.getOrders = this.getOrders.bind(this)
  }

  // RPC Methods
  // ----------------

  // Prepare a formatted query to be submitted as a JSON-RPC call
  static makeRPC(method, params = {}, id = uuid()) {
    return {
      jsonrpc: '2.0',
      method,
      params,
      id,
    }
  }

  // Send a JSON-RPC `message` to a `receiver` address.
  // Optionally pass `resolve` and `reject` callbacks to handle a response
  call(receiver, message, resolve, reject) {
    const messageString = JSON.stringify({
      sender: this.address.toLowerCase(),
      receiver,
      message: JSON.stringify(message),
      id: uuid(),
    })
    this.socket.send(messageString)

    // Set the promise resolvers and rejectors for this call
    if (typeof resolve === 'function') {
      this.RESOLVERS[message.id] = resolve
    }
    if (typeof reject === 'function') {
      this.REJECTORS[message.id] = reject
    }

    // Set a timeout for this call
    this.TIMEOUTS[message.id] = setTimeout(() => {
      if (typeof reject === 'function') {
        reject({ message: `Request timed out. [${message.id}]`, code: -1 })
      }
    }, TIMEOUT)
  }

  // WebSocket Interaction
  // ----------------

  // Connect to AirSwap by opening websocket. The sequence:
  // 1. Open a websocket connection
  // 2. Receive a challenge (some random data to sign)
  // 3. Sign the data and send it back over the wire
  // 4. Receive an "ok" and start sending and receiving RPC
  connect(reconnect = true) {
    this.socket = new WebSocket(this.socketUrl)

    // Check socket health every 30 seconds
    this.socket.onopen = function healthCheck() {
      this.isAlive = true
      // trying to make this isomorphic, and ping/pong isn't supported in browser websocket api
      if (this.ping) {
        this.addEventListener('pong', () => {
          this.isAlive = true
        })

        this.interval = setInterval(() => {
          if (this.isAlive === false) {
            console.log('no response for 30s; closing socket')
            this.close()
          }
          this.isAlive = false
          this.ping()
        }, 30000)
      }
    }

    // The connection was closed
    this.socket.onclose = () => {
      this.isAuthenticated = false
      clearInterval(this.socket.interval)
      if (reconnect) {
        console.log('socket closed; attempting reconnect in 10s')
        setTimeout(() => {
          this.connect()
        }, 10000)
      } else {
        console.log('socket closed')
      }
    }

    // There was an error on the connection
    this.socket.onerror = event => {
      throw new Error(event)
    }

    // Promisify the `onmessage` handler. Allows us to return information
    // about the connection state after the authentication handshake
    return new Promise((resolve, reject) => {
      // Received a message
      this.socket.onmessage = event => {
        // We are authenticating
        if (!this.isAuthenticated) {
          switch (event.data) {
            // We have completed the challenge.
            case 'ok':
              this.isAuthenticated = true
              console.log('Authentication successful')
              resolve(event.data)
              break
            case 'not authorized':
              reject(new Error('Address is not authorized.'))
              break
            default:
              // We have been issued a challenge.
              this.messageSigner(event.data).then(signature => {
                this.socket.send(signature)
              })
          }
        } else if (this.isAuthenticated) {
          // We are already authenticated and are receiving an RPC.
          let payload
          let message

          try {
            payload = JSON.parse(event.data)
            message = payload.message && JSON.parse(payload.message)
          } catch (e) {
            console.error('Error parsing payload', e, payload)
          }

          if (!payload || !message) {
            return
          }

          if (message.method) {
            // Another peer is invoking a method.
            if (this.RPC_METHOD_ACTIONS[message.method]) {
              this.RPC_METHOD_ACTIONS[message.method](message)
            }
          } else if (message.id) {
            // We have received a response from a method call.
            const isError = Object.prototype.hasOwnProperty.call(message, 'error')

            if (!isError && message.result) {
              // Resolve the call if a resolver exists.
              if (typeof this.RESOLVERS[message.id] === 'function') {
                this.RESOLVERS[message.id](message.result)
              }
            } else if (isError) {
              // Reject the call if a resolver exists.
              if (typeof this.REJECTORS[message.id] === 'function') {
                this.REJECTORS[message.id](message.error)
              }
            }

            // Call lifecycle finished; tear down resolver, rejector, and timeout
            delete this.RESOLVERS[message.id]
            delete this.REJECTORS[message.id]
            clearTimeout(this.TIMEOUTS[message.id])
          }
        }
      }
    })
  }

  // Disconnect from AirSwap by closing websocket
  disconnect() {
    this.socket.close(1000)
  }

  // Interacting with the Indexer
  // ----------------

  // Query the indexer for trade intents.
  // * returns a `Promise` which is resolved with an array of `intents`
  findIntents(makerTokens, takerTokens, role = 'maker') {
    if (!makerTokens || !takerTokens) {
      throw new Error('missing arguments makerTokens or takerTokens')
    }
    const payload = Messenger.makeRPC('findIntents', {
      makerTokens,
      takerTokens,
      role,
    })
    return new Promise((resolve, reject) => this.call(INDEXER_ADDRESS, payload, resolve, reject))
  }

  // Call `getIntents` on the indexer to return an array of tokens that the specified address has published intent to trade
  // * parameter `address` is a lowercased Ethereum address to fetch intents for
  // * returns a `Promise` which is resolved with an array of intents set by a specific address
  getIntents(address) {
    const payload = Messenger.makeRPC('getIntents', { address })
    return new Promise((resolve, reject) => this.call(INDEXER_ADDRESS, payload, resolve, reject))
  }

  // Call `setIntents` on the indexer with an array of trade `intent` objects.
  // * returns a `Promise` with the indexer response. Passes `'OK'` if succcessful.
  setIntents(intents) {
    const payload = Messenger.makeRPC('setIntents', {
      address: this.address.toLowerCase(),
      intents,
    })
    return new Promise((resolve, reject) => this.call(INDEXER_ADDRESS, payload, resolve, reject))
  }

  // Make a JSON-RPC `getOrder` call on a maker and recieve back a signed order (or a timeout if they fail to respond)
  // * `makerAddress`: `string` - the maker address to request an order from
  // * `params`: `Object` - order parameters. Must specify 1 of either `makerAmount` or `takerAmount`. Must also specify `makerToken` and `takerToken` addresses
  getOrder(makerAddress, params) {
    const { makerAmount, takerAmount, makerToken, takerToken } = params
    const BadArgumentsError = new Error('bad arguments passed to getOrder')

    if (!makerAmount && !takerAmount) throw BadArgumentsError
    if (makerAmount && takerAmount) throw BadArgumentsError
    if (!takerToken || !makerToken) throw BadArgumentsError

    const payload = Messenger.makeRPC('getOrder', {
      makerToken,
      takerToken,
      takerAddress: this.address.toLowerCase(),
      makerAmount: makerAmount ? String(makerAmount) : null,
      takerAmount: takerAmount ? String(takerAmount) : null,
    })
    return new Promise((res, rej) => this.call(makerAddress, payload, res, rej)).then(order => ({
      ...order,
      v: order.v ? ethers.utils.bigNumberify(order.v).toNumber() : order.v,
    }))
  }

  getQuote(makerAddress, params) {
    const { makerAmount, takerAmount, makerToken, takerToken } = params
    const BadArgumentsError = new Error('bad arguments passed to getOrder')

    if (!makerAmount && !takerAmount) throw BadArgumentsError
    if (makerAmount && takerAmount) throw BadArgumentsError
    if (!takerToken || !makerToken) throw BadArgumentsError

    const payload = Messenger.makeRPC('getQuote', {
      makerToken,
      takerToken,
      makerAmount: makerAmount ? String(makerAmount) : null,
      takerAmount: takerAmount ? String(takerAmount) : null,
    })
    return new Promise((res, rej) => this.call(makerAddress, payload, res, rej))
  }

  getMaxQuote(makerAddress, params) {
    const { makerToken, takerToken } = params
    const BadArgumentsError = new Error('bad arguments passed to getOrder')

    if (!takerToken || !makerToken) throw BadArgumentsError

    const payload = Messenger.makeRPC('getMaxQuote', {
      makerToken,
      takerToken,
    })
    return new Promise((res, rej) => this.call(makerAddress, payload, res, rej))
  }
  // Given an array of trade intents, make a JSON-RPC `getOrder` call for each `intent`
  getOrders(intents, params) {
    const { makerAmount, takerAmount } = params
    if (!Array.isArray(intents) || !(makerAmount || takerAmount)) {
      throw new Error('bad arguments passed to getOrders')
    }
    return Promise.all(
      intents.map(({ makerAddress, makerToken, takerToken }) => {
        const payload = Messenger.makeRPC('getOrder', {
          makerToken,
          takerToken,
          takerAddress: this.address.toLowerCase(),
          ...params,
        })

        // `Promise.all` will return a complete array of resolved promises, or just the first rejection if a promise fails.
        // To mitigate this, we `catch` errors on individual promises so that `Promise.all` always returns a complete array
        return new Promise((res, rej) => this.call(makerAddress, payload, res, rej)).catch(e => e)
      }),
    )
  }
}

module.exports = Messenger
