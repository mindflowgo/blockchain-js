/******************************************
 * Mining Class
 * 
 * (c) 2025 Filipe Laborde / fil@rezox.com
 * 
 * MIT License
 * 
 * Instantiate with, for example:
 *    nodeName (miner), host (localhost), port (5000), dataPath (./data):
 * 
 * const miner = new Miner({ nodeName, host, port, nodes, dataPath })
 * 
 * It will start a worker thread, and then try to reload all existing blocks
 * - mining timer will check every 10s on status or if pending transactions to work with
 * - heartbeat timer will send out ping to known peers, and process their responses
 * 
 * PUBLIC METHODS
 * Abstraction-wise, ONLY methods dealing at the level of the node are here, blockchain-associated 
 * ones are pushed down to that class, ledger-based ones in the ledger class.
 * 
 * Unconfirmed/pending transactions are dealt with in the node as they are relevant to it's
 * operations in deciding blocks to mine, and what info to communicate to other nodes.
 */

import path from 'path'
import Blockchain from './Blockchain.js'
import Ledger from './Ledger.js'
import { Worker } from 'worker_threads'
import { urlCall, sha256Hash, fixRounding, time, waitReady } from './helper.js'

// Miner Class =================================================================================
export default class Miner {
    constructor({ nodeName, host, port, nodes, dataPath }) {
        console.log(`\n\n**MINER** Created nodeName(${nodeName} @ ${host}:${port}) nodes(${nodes})`)
        console.log(`========================================================================`)
        this.version = '0:1.0'              // blockchain network : spec-version1.0
        this.nodeName = nodeName
        this.type = 'miner'                 // ARCHIVE, LOOKUP (just enough for lookups), MINER
        this.nodeState = 'LOADING'          // LOADING, ONLINE, REBUILDING, OFFLINE
        this.startTime = time()
        this.host = host
        this.port = port
        this.peers = []
        this.pendingTransactions = []       // mempool transactions want to put into an upcoming block
        this.rejectedTransactions = []      // mempool of recently rejected
        this.dataPath = dataPath
        this.workerStatus = ''
        this.workerBlock = {}
        this.worker = null

        // add hardcoded peers
        this.addPeers( nodes ) //peers.map( peer =>{ return { hostname: peer, dir: 'out', pingNext: time()-300, pingError: 0 } })

        // the address wallets
        this.ledger = new Ledger( path.join(this.dataPath, this.nodeName, 'ledger.json') )
        // setup wallet for this miner (if not already existing)
        this.ledger.createWallet(nodeName)
        // reset the balances; compile ledger based on blockchain
        this.ledger.reset()

        // init blockchain
        this.blockchain = new Blockchain({ nodeName, version: this.version, ledger: this.ledger, dataPath })
        // BUGBUG remove 
        console.log( `\n== LEDGER ========================================`)
        this.ledger.walletBalances()

        // generate balances from each transaction in each block
        // this.blockchain.updateLedgerFromBlock()

        // Start mining Worker thread
        this.#startMinerThread()
        // Run periodic mining attempt (that offloads task to worker)
        this.mine()

        // everything worked, our node should now be online able to respond to queries
        this.nodeState = 'ONLINE'

        // Make presence known
        this.broadcastPeers({ path: '/node/announce', data: this.minerAnnounceInfo(this.blockchain.height()) })
            .then( response => this.minerAnnounceResponse(response) )
        
        // periodic check-in with everyone
        this.heartbeat()
    }
    
    #startMinerThread(){
        this.worker = new Worker(path.resolve('./lib', 'MinerWorker.js'))
        this.worker.on('message', ({ action, ...result }) => {
            switch( action ){
                case 'UPDATE':
                    console.log( `  ~ [Miner] Update from worker (nonce=${result.nonce}, elapsed=${result.elapsed}s)` )
                    break
                case 'SOLVED':
                    this.workerBlock = result.block
                    this.workerStatus = 'SOLVED'
                    break
            }
        })
      
        this.worker.on('error', (error) => {
            console.error('Worker error:', error)
        })
    
        this.worker.on('exit', (code) => {
            console.error(`Worker stopped with exit code ${code}`); // code 0 = normal
        })
    }

    addPeers( nodes ){
        if( !nodes || nodes.length<1 ) return false
        // remove existing nodes and myself
        const existingNodes = [ `http://${this.host}:${this.port}`, ...this.peers.map( node => node.hostname ) ]
        // only get new nodes and convert into a peer structure
        const newNodes = nodes.filter( node => !existingNodes.includes(node) )
                              .map( node =>{ return { hostname: node, dir: 'out', pingNext: time()-300, pingError: 0 } })
        if( newNodes.length<1 ) return []

        console.log( `  .. [addPeers] --> newNodes (${newNodes.map( node => node.hostname ).join(',')})` )
        this.peers = [ ...this.peers, ...newNodes ]
        return newNodes
    }

    heartbeat(){
        // real BTC server: send heartbeach every 30mins, if none after 90, assume client connection closed
        // us: send every 30s, 120s assume gone
        setInterval(async () => {
            const _heartbeat_peers = this.peers.map(peer => peer.hostname).join(',')
            // if( _heartbeat_peers ) console.log( `[heartbeat] (${_heartbeat_peers})`)
            if (this.peers.length > 0) {
                // only ping peers after delay (pingNext)
                const pingNextPeers = this.peers.filter(peer => peer.pingNext < time())
                this.broadcastPeers({ path: '/node/status?bH='+this.blockchain.height(), peers: pingNextPeers })
                    .then( response => this.minerAnnounceResponse(response) )

                // the valid peer with longest chain we request from!
                
                // const response = await urlCall({hostname: longestChain.hostname, '/blocks'})

                // blockchain = { index: block.index, hash: block.hash, timestamp: block.timestamp } 
                // res.end( JSON.stringify({ nodeName: miner.minerName, timestamp: miner.timestamp, blockchain, blockchainHeight: miner.blockchain.chain.length }) )
            }
        }, 60000)
    }

    minerAnnounceInfo( queryBlockIndex=-1 ){
        // connect to a peer, send: version number, block count, hash of latest, and current time
        // they send all their peers, if you block not latest, they will send up to 500 blocks ahead of it (then you process and request more)
        const response = {
            nodeName: this.nodeName,
            version: this.version,
            hostname: 'http://' + this.host + ':' + this.port,
            type: this.type,
            startTime: this.startTime,
            timestamp: time(),
            peers: this.peers.map(peer=>peer.hostname), // only pass on hostname
            blockchainHeight: this.blockchain.height(),
            blockchain: []
        }

        // they want to know about a specific chain item (queryBlockItem), send it
        // with this, they can verify our blockchains sync to that point
        if( queryBlockIndex>-1 && queryBlockIndex <= this.blockchain.height() )
            response.blockchain.push({ index: this.blockchain.getBlock(queryBlockIndex).index, hash: this.blockchain.getBlock(queryBlockIndex).hash })
        
        return response
    }

    async minerAnnounceResponse( response ){
        if( response.error ) return response
        
        if( response.result.length<1 )
            return { error: false} // nothing to process, maybe no nodes

        // review each response
        const NEXT_PING = 30 // 120
        const ERROR_PING = 15 // 300
        let nodes = []
        for( let node of response.result ){
            // setup pingNext for this peer
            const peerIdx = this.peers.findIndex( peer => peer.hostname === node.hostname )
            if( node.error ){
                this.peers[peerIdx].pingError = (this.peers[peerIdx].pingError || 0) + 1
                this.peers[peerIdx].pingNext = time() + this.peers[peerIdx].pingError * ERROR_PING // 300
                // console.log( `  .. peer (${node.hostname}) problem, pingError(${this.peers[peerIdx].pingError}) pingNext(+${this.peers[peerIdx].pingError * ERROR_PING})`)
            } else {
                this.peers[peerIdx].pingNext = time() + NEXT_PING // 120
                this.peers[peerIdx].pingError = 0
                // console.log( `  .. peer (${node.hostname}) ok, next ping in +${NEXT_PING}s` )
                nodes.push(node)
            }
        }

        // any nodes?
        if( nodes.length<1 )
            return { error: `No nodes to connect with. Aborting.`}

        // get node with the longest chain
        console.log( `   .. connected peers: ` + nodes.map( node => `${node.nodeName} [${node.blockchainHeight}] (${node.pendingTransactions?.length || 0})` ).join('; ') )
        const selNode = nodes.reduce((max, item) => item.blockchainHeight > max.blockchainHeight ? item : max)
        // console.log('/node/status response:', selNode )
        if( selNode.blockchainHeight <= this.blockchain.height() )
            return { error: false }  // same height, nothing more to do.

        console.log( `[${selNode.hostname}] has a longer blockchain (${selNode.blockchainHeight})` )
        let latestBlock = this.blockchain.getBlock() // latest block
        const nodeMatchBlock = selNode.blockchain.pop()
        // console.log( `our us:them #${latestBlock.index}:${nodeMatchBlock.index} hash(${latestBlock.hash}:${nodeMatchBlock.hash})`)

        // if node's block at same height as ours matches, we can safely continue to build blockchain with it
        if( nodeMatchBlock.index !== latestBlock.index || nodeMatchBlock.hash !== latestBlock.hash ){
            this.peers = this.peers.filter( node => node.hostname !== selNode.hostname )
            console.log( ` x Node (${selNode.hostname}) has more blocks, but MISMATCHING index/hash @ #${latestBlock.index}, finding last common node, and overwriting rest` )
            this.nodeState = 'LOADING'

            // request last 100 hashes and we'll try to find last matching block
            const fromIndex = Math.max(0, this.blockchain.height()-100 )
            const response = await urlCall({ hostname: selNode.hostname, path: `/blocks/hashes?fromIndex=${fromIndex}`, nodeToken: this.nodeName })
            if( response.error ) return response
            // now work our back way to find first matching chain
            for( let i=this.blockchain.height()-fromIndex; i>0; i-- ){
                if( this.blockchain.getBlock(i+fromIndex).hash !== response.result[i-1] ){
                    console.log(`  .. block #${i} different, deleting ours!`)
                    this.blockchain.getBlock(i+fromIndex).deleteFile()
                } else {
                    console.log(` .. found MATCH @ #${i}, syncing from there.`)
                    // REFRESHING our latest block to now be the trimmed chain
                    latestBlock = this.blockchain.getBlock()
                    console.log( `       latestBlock:`, latestBlock )
                    break
                }
            }
            // return { error: `Node (${selNode.hostname}) has more blocks, but MISMATCHING index/hash @ #${latestBlock.index}, DE-peering` }
        }

        console.log( ` > their chain matches mine to #(${latestBlock.index}), requesting MORE (/blocks?fromIndex=${latestBlock.index})... latestBlock:`)
        let addResult
        try {
            // since we aren't longest don't accept calls for now?
            this.nodeState = 'LOADING'
            const response = await urlCall({ hostname: selNode.hostname, path: `/blocks?fromIndex=${latestBlock.index}`, nodeToken: this.nodeName })
            if( response.error ) return response

            // add these new blocks, first write them, then sync transactions
            const newBlocks = response.result
            addResult = this.blockchain.addBlockchain(newBlocks)
            this.nodeState = 'ONLINE'
            if( addResult.error ) return addResult
  
        } catch (e) {
            console.log(`     ! Error with peer: ${e.message}`)
            return { error: e.message }
        }

        const { addBlockCnt, transactionCnt }= addResult
        return { error: false, addBlockCnt, transactionCnt }
    }

    async broadcastPeers({ path, data = '', peers = this.peers, all = false }) {
        const broadcastPeers = peers.filter( peer => (all || (peer.dir === 'out' && peer.pingNext < time())) ) // only those allowing ping
        // console.log( `[broadcastPeers]`, peers )
        // console.log( ` .... broadcastPeers:`, broadcastPeers )
        console.log(`<< [${this.nodeName}]${path} @ (${broadcastPeers.map( node => node.hostname ).join(',')})` )

        const requests = broadcastPeers.map(async (peer, idx) => {
            // the 'node'
            const request = { hostname: peer.hostname || peer, path, nodeToken: this.nodeName }
            if (data) request.body = data
            try {
                const response = await urlCall(request)
                response.hostname = request.hostname
                if( response.error ) return response

                // only deal with servers that are within 30 minutes of us
                if( Math.abs(response.timestamp - time()) > 1800 )
                    throw new Error('Peers time unavailable / 30+ minutes off')

                // Update next ping time
                this.peers[idx].pingNext = time() + 120
                
                // in our peers object, track some stuff from the responding peer
                for( let key of ['version','nodeName','type','startTime','blockchainHeight'] )
                    if( response[key] ) this.peers[idx][key] = response[key]

                // if they have peers, let's add them & announce ourselves
                if( response.peers ){
                    const newPeers = this.addPeers( response.peers )
                    this.broadcastPeers({ path: '/node/announce', peers: newPeers, data: this.minerAnnounceInfo(this.blockchain.height()) })
                        .then( response => this.minerAnnounceResponse(response) )
                }
                return response //  { ...response, hostname: peer.hostname }

            } catch (e) {
                console.error(`Error with peer ${peer.hostname}: ${e.message}`)
                return { error: e.message, hostname: request.hostname }
            }
        })
        const result = (await Promise.all(requests)).filter(res => res !== null)
        // console.log(`    - responses:`, responses)
        return { error: false, result }
    }


    // miner fee
    transactionFee({ amount, fee=0 }){
        // transaction occurs in Ledger, but we contribute the fee our miner charges here
        // users can offer to pay a higher fee (may prioritize placement in blocks; we don't offer that)
        if( fee<0 ) fee = 0
        fee = fixRounding( Math.max(fee, Number(amount || 0) * this.blockchain.transactionFee) )
        return fee
    }
    
    // submit a transaction to miner
    transaction({src, dest, amount, fee = 0, seq = 0, txSig = '', hash = '', ...data}) {
        // Validate transaction
        if (!src || !dest || !amount) {
            console.log(`Invalid transaction (src: ${src}, dest: ${dest}, amount: ${amount}). Rejecting.`)
            return { error: `Invalid transaction (src: ${src}, dest: ${dest}, amount: ${amount}). Rejecting.` }
        }

        if( src.startsWith('_') ){
            // _admins don't pay fees in our blockchain
            fee = 0
        } else {
            // non-admins are charged transaction fee, and src sequence expected to be incremental over last
            const srcWallet =  this.ledger.getWallet(src)
            if( srcWallet.error ) return srcWallet // error return it

            // verify their transaction sequence is ok
            if( Number(seq) !== Number(srcWallet.seq) + 1 ){
                console.log( `Invalid src sequence (seq=${seq}), expected ${srcWallet.seq+1}` )
                return { error: `Invalid src sequence (seq=${seq}), expected ${srcWallet.seq+1}`, seq: srcWallet.seq+1 }
            }

            // verify there are excess pending from this src, reject it
            const transSrc = this.ledger.buildTransactionName(src, srcWallet.publicKey)
            const pendingSrcCnt = this.pendingTransactions.filter( t => t.src === transSrc ).length
            if( pendingSrcCnt>16 ) {
                return { error: `Sorry too many transactions (${pendingSrcCnt}) by user (${src}). Please resubmit later once blocks mined.` }
            }
            fee = this.transactionFee({ amount, fee })
        }

        // issue a stake request as it came through us
        const txStake = `${this.nodeName}:${time()}`
        const newTransaction = this.blockchain.transaction({src, dest, amount, fee, seq, txSig, hash, ...data, txStake})

        // put into pending transactions (if no error)
        if( !newTransaction.error )
            this.pendingTransactions.push( newTransaction )

        // add sender balance to the returned transaction (for end user knowledge)
        const { balance } =  this.ledger.getWallet(src)
        return { ...newTransaction, balance }
    }

    pruneTransactions( transactions ){
        const transactionHashes = transactions.map( t => t.hash )
        this.pendingTransactions = this.pendingTransactions.filter( t => !transactionHashes.includes(t.hash) )

        return transactionHashes
    }


    // mining state machine
    mine() {
        let mineTransactions = []
        let errorTransactions = []
        let rewardTransactions = []
        this.workerStatus = 'READY'
        
        const workerMinePending = () => {
        switch( this.workerStatus ){
            case 'READY':
                // reset our working transactiong
                // TODO figure out better BUGBUG
                mineTransactions = []
                errorTransactions = []
                rewardTransactions = []

                const calc = this.blockchain.calcMiningReward(this.blockchain.height()+1)
                this.blockchain.miningReward = calc.miningReward
                this.blockchain.difficulty = calc.difficulty

                // gather transactions to be mined --> those staked by us (BTC different -- tries to mine ANY transactions pending)
                // ASSUME: we are going with (likely valid) belief if there's a clump of user-transactions they coming from same server, 
                //         -> so timestamp will be exact for them relative to each other (don't want timestamp <> seq # to be off!)
                // ORDER BY txSig <> '', timestamp, src, seq  LIMIT 10
                mineTransactions = this.pendingTransactions.filter( t => t.txStake.startsWith(this.nodeName+':'))
                    .sort((a, b) => ( (b.hasOwnProperty('txSig') - a.hasOwnProperty('txSig')) || (a.timestamp - b.timestamp) ||
                                       a.src.localeCompare(b.src) || (a.seq - b.seq))).slice(0,10)

                // anything to mine for this node? if not wait till I can stake some transactions
                if( mineTransactions.length === 0 ) break

                console.log( `*** MINING START (${this.nodeName}) *** (difficulty: ${this.blockchain.difficulty}) reward=${this.blockchain.miningReward}`)
                mineTransactions.forEach( t => {
                    // indicate we are mining in th metadata -> in this.pendingTransactions
                    // const idx = this.pendingTransactions.find( pT => pT.hash === t.hash)
                    // if (idx) this.pendingTransactions[idx]
                    t.txStake += ' MINING:' + time()
                    if( t.fee>0 ) 
                        rewardTransactions.push( this.blockchain.transaction(
                        { src: '_mint', dest: this.nodeName, amount: t.fee, type: 'miningFees', source: t.hash } ) )
                })

                // block mining reward
                if( this.blockchain.miningReward>0 )
                    rewardTransactions.push( this.blockchain.transaction(
                    { src: '_mint', dest: this.nodeName, amount: this.blockchain.miningReward, type: 'miningReward' }))

                // problems setting up rewardTransactions? ABORT!
                if( rewardTransactions.filter( t => t.error ).length > 0 ){
                    console.log( ` .. preparing mining, but problem with reward transaction: aborting!`, rewardTransactions )
                    this.workerStatus = 'UNDO'
                    break
                }

                // append reward transactions to prepare our mining transaction block
                mineTransactions = [ ...mineTransactions.concat( rewardTransactions ) ]

                // remove miner meta-data (ex. txStake) as not included in block
                mineTransactions = mineTransactions.map( ({txStake, balance, ...data }) => data )
                // console.log( ` LBLOCK TRANSACTION:S`, mineTransactions )

                // no errors, great build markleTree and add block
                if( mineTransactions.length === 0 ){
                    console.log( `strange error, no mine transactions: `, this.pendingTransactions )
                    break
                }

                const [ merkleRoot ]= this.blockchain.merkleBuild( mineTransactions ).pop()

                const blockData = {
                    merkleRoot,
                    transactions: mineTransactions
                }
                // Create a new block with pending transactions, include calculated rewards mining server will get if this block accepted by other nodes
                // transaction as "n/unconfirmed" until the transaction is 6 blocks deep
                const newBlock = this.blockchain.addBlock(blockData, { prepareOnly: true })
                if( newBlock.error ){
                    this.workStatus = 'UNDO'
                    break
                }

                // offload to worker thread to solve (keeps system responsive)
                this.workerStatus = 'MINING'
                this.workerBlock = { index: blockData.index }
                this.worker.postMessage({action: 'MINE', block: newBlock.block, difficulty: this.blockchain.difficulty})
                break
        
            case 'MINING':
                // while mining it will loop back to this place
                // this.worker.postMessage({action: 'ABORT' ) // abort if taking too long?
                // console.log( ' ~ [Miner] checking in, worker still mining' )
                break;

            case 'SOLVED':
                // Worker thread should have solved, now 'this.workerBlock' has a full solution nonce
                const { error: addError, block } = this.blockchain.addBlock(this.workerBlock)
                if( addError ){
                    console.log( `[addBlock] ${addError}` )
                    this.workerStatus = 'UNDO'
                    break
                }
                // block successfully added, make sure transactions in ledger (and in transactionHashes)
                const { error, transactionCnt, newHashes, hashes } = this.blockchain.syncBlockTransactions( block.index, 1 )
                if( error ){
                    console.log( ` .. SOLVED but then had problems adding transactions (successfully added: ${transactionCnt}). Aborting` )
                    this.workerStatus = 'UNDO'
                    break
                }

                // now remove them from pendingTransactions
                this.pendingTransactions = this.pendingTransactions.filter( t => !hashes.includes(t.hash) )

                console.log( `SOLVED (in ${block.powTime}s) block: hashes(${hashes.length}) (${newHashes.length} new for transactionHashes); scanning pendingTransactions and removing any that were published in this block.` )
                if( this.pendingTransactions.length>0 ) console.log( `pendingTransactions left: `, this.pendingTransactions )    
                // tell everyone about block
                this.broadcastPeers({ path: '/blocks/announce', data: [block], all: true })

                // ready to tackle another block
                this.workerStatus = 'READY'
                break

            case 'UNDO':
                // only need to undo rewards as block transactions can still be added to another block
                rewardTransactions = rewardTransactions.filter( t => !t.error )
                // console.log( 'undoHashes: ', undoHashes )
                if( rewardTransactions.length === 0 ){
                    console.log( `.. came to ${this.workerStatus} but nothing to undo. ` )
                    this.workerStatus = 'READY'
                    break
                }

                rewardTransactions.forEach( t => {
                    this.rejectedTransactions.push( this.blockchain.transactionReverse( t ) )
                })

                // TODO release stake claim on these

                this.workerStatus = 'READY'
                break
            }

            // Update ledger balances using minted block, and change in transactions
            // this.blockchainLedgerBalances( newIndex )
        } 
        
        // check-in every so often and try mining or seeing progress on mining
        setInterval(() => {
            if (this.workerStatus !== 'READY' || 
                (this.pendingTransactions.filter( t => t.txStake.startsWith(this.nodeName+':'))).length > 0) {
                workerMinePending()
            }
        }, 10000); // Try to mine a new block every minute, simulating delay that real miner has tackling complex PoW calcs
    }
}