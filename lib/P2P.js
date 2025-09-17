/**************************************************************************
 * P2P Network Module
 * 
 * (c) 2025 Filipe Laborde, fil@rezox.com
 * 
 * MIT License
 * 
 * This module handles pure peer-to-peer networking operations:
 * peer discovery, communication, and broadcasting. All blockchain-specific
 * logic is handled via callbacks.
 * ***********************************************************************/

import { urlCall, time, debug, formatURL } from './helper.js'

// from .env
const NODE_TIMESTAMP_TOLERANCE = process.env.NODE_TIMESTAMP_TOLERANCE   // how much can a node be different than our time before ignoring it
const HEARTBEAT_INTERVAL = process.env.HEARTBEAT_INTERVAL               // how often to announce heartbeat, check blockchain height
const ONLINE_DELAY = process.env.ONLINE_DELAY                           // wait 70s before mining

export default class P2P {
    constructor( nodeName, host, port, peers, Blockchain, fnQueueLength ) {
        this.nodeName = nodeName
        this.hostname = formatURL(`${host}:${port}`)
        this.peers = {}
        this.heartbeatCnt = 0
        this.nodeState = 'PREPARING' 

        // classes
        this.Blockchain = Blockchain
        this.fnQueueLength = fnQueueLength
        // add hardcoded known peers, including self
        peers.push(this.hostname)
        this.addPeers(peers)

        // periodic check-in with everyone
        this.heartbeat()
        setInterval(() => { this.heartbeat() }, HEARTBEAT_INTERVAL * 1000)

        // online come online after it's had time to update chain, discover peers, etc
        setTimeout( ()=>{ this.nodeState = 'ONLINE' }, ONLINE_DELAY * 1000 )

    }

    addPeers(peers) {
        let newHosts = []
        peers.forEach(host => {
            if (host && host.length>5 && this.peers[host] === undefined) {  
                host += (!host.endsWith('/') ? '/' : '')
                debug('cyan', `   + NEW peer: ${host}`)
                this.peers[host] = { hostname: host, nodeName: '', dir: 'out', pingError: 0 }
                newHosts.push(host)
            }
        })
        return newHosts
    }

    getNodeState(state) {
        return this.nodeState
    }

    setNodeState(state) {
        if (this.nodeState !== 'PREPARING') this.nodeState = state
    }

    nodeStats() {
        const toMb = (name, val) => { const stat = (val / 1024 / 1024).toFixed(1); return stat > 5 ? `${name}: ${stat}MB, ` : '' }
        const memoryUsage = process.memoryUsage()
        debug('blue', `${this.nodeState}; Stats: Memory Usage - ${toMb('Total', memoryUsage.rss)}${toMb('Heap', memoryUsage.heapTotal)}`
            + `${toMb('Array Buffers', memoryUsage.arrayBuffers)}${toMb('External', memoryUsage.external)}`)
    }

    // real BTC server: send heartbeach every 30mins, if none after 90, assume client connection closed
    // us: send every 30s, 120s assume gone
    async heartbeat() {
        this.nodeStats()
        this.heartbeatCnt++

        const peers = this.getPeersData().map(node => node.hostname)
        if (peers.length > 0) {
            // Announce to peers
            this.broadcastPeers({ path: 'node/announce', peers, data: this.pingInfo() })
                .then(response => this.pingResponseProcess(response))

            if( this.getNodeState() === 'ONLINE' ){
                // online so let's check our blockchain length matches others
                this.setNodeState('SYNC_CHAIN')
                const { hostname, height }= this.findPeerMostBlocks()
                if( height && height > 0 ){
                    const result = await this.syncPeerBlocks( hostname )
                    if( result.error ) debug( 'red', result.error )
                }
                this.setNodeState('ONLINE')
            }
        }
    }

    pingInfo( queryBlockIndex=this.Blockchain.height()-1 ){
        // a node/announce includes key info about this node, including timestamp and who it knows, and block length
        // they send all their peers, if you block not latest, they will send up to 500 blocks ahead of it (then you process and request more)
        const response = {
            nodeName: this.nodeName,
            version: this.version,
            nodeState: this.getNodeState(),
            hostname: this.hostname,
            type: this.type,
            startTime: this.startTime,
            timestamp: time(),
            peers: Object.keys(this.peers), // only pass on hostname
            pendingTransactionsCnt: this.fnQueueLength(),
            blockchainHeight: this.Blockchain.height(),
            blockAtHeight: {}
        }

        // if info is response to another node, they specified their block-height,
        // we specify our hash/timestamp for that height-block
        if( queryBlockIndex < this.Blockchain.height() ) {
            const queryBlock = this.Blockchain.getBlock(queryBlockIndex)
            response.blockAtHeight = { index: queryBlock?.index || 0, 
                                        hash: queryBlock?.hash || '', 
                                        timestamp: queryBlock?.timestamp || 0 }
        }
        return response
    }
    
    pingResponseProcess(response) {
        if (response.error || response.result.length < 1)
            return { error: response.error || false }

        // review each response, add to peers table
        for (let node of response.result) {
            if (node.error) {
                const peer = this.peers[node.hostname]
                if (peer)
                    peer.pingError = (peer.pingError || 0) + 1
            } else {
                // gather all self-reporting data from peer into peers object
                delete node.error
                delete node.peers
                this.peers[node.hostname] = { ...this.peers[node.hostname], ...node, pingError: 0 }
            }
        }
    }

    async broadcastPeers({ path, data = '', peers }) {
        let broadcastPeers
        if (peers === undefined || peers.length < 1)
            broadcastPeers = Object.keys(this.peers).filter(host => host !== this.hostname)
        else
            broadcastPeers = peers.filter(host => host !== this.hostname)

        if (broadcastPeers.length > 0) {
            const color = path.includes('node/announce') ? 'dim' : 'cyan'
            const pending = path.includes('node/announce') ? ` pendingTransactions(${data.pendingTransactionsCnt || 0})` : ''
            debug(color, `<< [${this.nodeName}]${path} [${this.getNodeState()}]${pending} @ (${broadcastPeers.join(',').replaceAll('http://localhost:', '')})`)
        }

        const requests = broadcastPeers.map(async (host) => {
            const response = await this.callPeer(host, path, data) 
            response.hostname = host
            if (response.error) {
                debug('dim', `   ! urlCall error: ${response.error}`)
                return response
            }

            // only deal with servers that are within 30 minutes of us
            if (Math.abs(response.timestamp - time()) > NODE_TIMESTAMP_TOLERANCE)
                return { ...response, error: 'Peers time unavailable of way off, ignoring!' }

            // in our peers object, track some stuff from the responding peer
            for (const key of ['nodeName', 'version', 'nodeState', 'type', 'startTime', 'timestamp', 'pendingTransactionsCnt', 'blockchainHeight'])
                if (response[key]) this.peers[host][key] = response[key]

            // if they have peers, let's add them & announce ourselves
            if (response.peers) {
                const newPeers = this.addPeers(response.peers)
                if (newPeers.length > 0)
                    this.broadcastPeers({ path: 'node/announce', peers: newPeers, data })
                        .then(response => this.pingResponseProcess(response))
            }
            return response
        })
        const result = (await Promise.all(requests)).filter(res => res !== null)
        return { error: false, result }
    }

    // Get peer information for blockchain sync decisions
    getPeersData() {
        return Object.values(this.peers)
    }

    // Get our hostname for peer comparisons
    getHostname() {
        return this.hostname
    }

    // Make HTTP call to peer (wrapper around urlCall)
    async callPeer(hostname, path, data = null) {
        const request = { url: hostname + path, nodeToken: this.nodeName }
        if (data) request.body = data
        return await urlCall(request)
    }

    // Broadcast blocks to peers
    broadcastBlock(block) {
        return this.broadcastPeers({ path: 'block/announce', data: block })
    }

    // Broadcast blocks to peers
    broadcastTransaction(transaction) {
        return this.broadcastPeers({ path: 'transaction/announce', data: transaction })
    }

    // scan through peers and see if we should ask for blocks from anyone
    findPeerMostBlocks(){
        const peers = this.getPeersData()
        const myHeight = this.Blockchain.height()
        const latestBlock = this.Blockchain.getBlock()

        if( peers.length<1 )
            return { error: `No nodes to connect with. Aborting.`}

        // fill OUR details in peers structure for comparison
        this.peers[this.hostname].blockchainHeight = myHeight
        this.peers[this.hostname].blockAtHeight = latestBlock

        // PICK peer with LONGEST CHAIN; if same as us, one with OLDEST timestamp
        let selNode = peers.reduce((sel, item) => item.blockchainHeight >= sel.blockchainHeight ? item : sel)
        if( selNode.blockchainHeight === myHeight && selNode.blockAtHeight.index === latestBlock.index ) 
            selNode = peers.reduce((sel, item) => item.blockchainHeight === sel.blockchainHeight && 
                                                  item.blockAtHeight.timestamp < sel.blockAtHeight.timestamp ? item : sel)

        if( !selNode?.nodeName || selNode.blockchainHeight < myHeight || selNode.blockAtHeight.index < latestBlock.index || 
            (selNode.blockchainHeight === myHeight && selNode.blockAtHeight.timestamp >= latestBlock.timestamp ) ){
            // there is no node with longer chain or same-height & older timestamp or there's a problem with selNode so don't proceed
            return { error: false }
        }

        // A BETTER chain exists - let's find from whence we shall sync and redo ours.
        debug( 'bold', ` x US (${this.nodeName}) vs THEM (${selNode.nodeName}): blocks(${this.Blockchain.height()} vs ${selNode.blockchainHeight}) timestamp(${latestBlock.timestamp} vs ${selNode.blockAtHeight?.timestamp || 'n/a'}) (ours: #${latestBlock.index}/${latestBlock.timestamp}, theirs: #${selNode.blockAtHeight?.index || 'n/a'}/${selNode.blockAtHeight?.timestamp || 'n/a'}, finding last common node, and overwriting rest` )

        // now sync from this one
        return { error: false, height: selNode.blockchainHeight, hostname: selNode.hostname }
    }

    async syncPeerBlocks(hostname){
        // request last 100 hashes [arbitrary choice] and we'll try to find last matching block
        const fromIndex = Math.max(0, this.Blockchain.height()-100 )
        const response = await this.callPeer( hostname, `blocks?fromIndex=${fromIndex}&type=hashes` )
        if( response.error ) return response

        // now work our back way to find highest matching block
        const latestBlock = this.Blockchain.getBlock()
        let index = latestBlock.index
        for( let i=this.Blockchain.height()-1; i >= fromIndex; i-- ){
            if( !response.result[i-fromIndex] ) return { error: `Invalid /blocks result: `, result: response.result }

            if( this.Blockchain.getBlock(i).hash === response.result[i-fromIndex].hash ){
                index = i
                debug('bold', ` ~ found MATCH @ #${i}, syncing from there.`)
                break
            }
        }

        debug('cyan',` > [${hostname}] chain matches mine to #(${index}), getting remainder and overwriting ours ... `)
        let responseBlocks, foundHashes = []
        try {
            // since we aren't longest, nodeState should not be ONLINE, as we attempt to sync-up
            responseBlocks = await this.callPeer( hostname, `blocks?fromIndex=${index+1}` )
            if( responseBlocks.error ) return responseBlocks

            // add these new blocks, first write them, then sync transactions
            const newBlocks = responseBlocks.result
            if( newBlocks.length>0 ){
                debug('dim',`   + got blocks to add: ` + newBlocks.map( b => b.index ).join(',') )
                const addResult = this.Blockchain.addChain(newBlocks, { forceOverwrite: true, txUpdate: true })
                if( addResult.error ) return addResult
                debug('dim',`  >>> added ${addResult.addBlockCnt} blocks containing ${addResult.transactionCnt} transactions; pruned pending transactions (${foundHashes})` )
                if( addResult.resetLedger ){
                    debug('green', "Note: resetLedger called, so syncing multiple prior blocks...")
                }
            }
            return { error: false, foundHashes }

        } catch (e) {
            debug('red',`     ! Error with peer: ${e.message} urlCall(blocks?fromIndex=${index+1}) -> response: `, responseBlocks )
            return { error: e.message }
        }
    }
}