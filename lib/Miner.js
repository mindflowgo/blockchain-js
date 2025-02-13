import path from 'path'
import Blockchain from './Blockchain.js'
import Ledger from './Ledger.js'
import { Worker } from 'worker_threads'
import { urlCall, sha256Hash, fixRounding, time } from './helper.js'

// Miner Class =================================================================================
export default class Miner {
    constructor({ nodeName, host, port, nodes, dataPath }) {
        console.log( `**MINER** Created nodeName(${nodeName} @ ${host}:${port}) nodes(${nodes})`)
        this.version = '0:1.0'              // blockchain network : spec-version1.0
        this.nodeName = nodeName
        this.type = 'miner' // ARCHIVE, LOOKUP (just enough for lookups), MINER
        this.startTime = time()
        this.host = host
        this.port = port
        this.peers = []
        this.pendingTransactions = []       // mempool transactions want to put into an upcoming block
        this.rejectedTransactions = []      // mempool of recently rejected
        this.dataPath = dataPath
        this.workerStatus = 'IDLE'
        this.workerBlock = {}
        this.worker = null

        // add hardcoded peers
        this.addPeers( nodes ) //peers.map( peer =>{ return { hostname: peer, dir: 'out', pingNext: time()-300, pingError: 0 } })

        // the address wallets
        this.ledger = new Ledger( path.join(this.dataPath, this.nodeName, 'ledger.json') )
        // setup wallet for miner (if needed)
        this.ledger.createWallet(nodeName)

        // init blockchain
        this.blockchain = new Blockchain({ nodeName, version: this.version, ledger: this.ledger, dataPath })
        
        // reset the balances; compile ledger based on blockchain
        this.ledger.clear()
        this.ledgerBalances()

        // Start mining
        this.startMinerThread()
        this.mine()

        // Make presence known
        this.broadcastPeers({ path: '/node/announce', data: this.minerAnnounceInfo(this.blockchain.height()) })
            .then( response => this.minerAnnounceProcess(response) )
        
        // periodic check-in with everyone
        this.heartbeat()
    }
    
    startMinerThread(){
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
            // console.log('Result from worker:', result);
        });
      
        this.worker.on('error', (error) => {
            console.error('Worker error:', error);
        });
    
        this.worker.on('exit', (code) => {
            if (code !== 0) {
            console.error(`Worker stopped with exit code ${code}`);
            }
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
            if (this.peers.length > 0) {
                this.peers = this.peers.filter(peer => peer.pingNext < time())
                this.broadcastPeers({ path: '/node/status?bH='+this.blockchain.height() })
                    .then( response => this.minerAnnounceProcess(response) )

                // the valid peer with longest chain we request from!
                
                // const response = await urlCall({hostname: longestChain.hostname, '/blocks'})

                // blockchain = { index: block.index, hash: block.hash, timestamp: block.timestamp } 
                // res.end( JSON.stringify({ nodeName: miner.minerName, timestamp: miner.timestamp, blockchain, blockchainHeight: miner.blockchain.chain.length }) )
            }
        }, 30000)
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
            response.blockchain.push({ index: this.blockchain.chain[queryBlockIndex].index, hash: this.blockchain.chain[queryBlockIndex].hash })
        
        return response
    }

    async minerAnnounceProcess( response ){
        if( response.error ) return response
        
        if( response.result.length<1 )
            return { error: false} // nothing to process, maybe no nodes

        // review each response
        const NEXT_PING = 120 // 120
        const ERROR_PING = 120 // 300
        let nodes = []
        for( let node of response.result ){
            // setup pingNext for this peer
            const peerIdx = this.peers.findIndex( peer => peer.hostname === node.hostname )
            if( node.error ){
                this.peers[peerIdx].pingError = (this.peers[peerIdx].pingError || 0) + 1
                this.peers[peerIdx].pingNext = time() + this.peers[peerIdx].pingError * ERROR_PING // 300
                console.log( `  .. peer (${node.hostname}) problem, pingError(${this.peers[peerIdx].pingError}) pingNext(+${this.peers[peerIdx].pingError * ERROR_PING})`)
            } else {
                this.peers[peerIdx].pingNext = time() + NEXT_PING // 120
                this.peers[peerIdx].pingError = 0
                console.log( `  .. peer (${node.hostname}) ok, next ping in +${NEXT_PING}s` )
                nodes.push(node)
            }
        }

        // any nodes?
        if( nodes.length<1 )
            return { error: `No nodes to connect with. Aborting.`}

        // get node with the longest chain
        const selNode = nodes.reduce((max, item) => item.blockchainHeight > max.blockchainHeight ? item : max)
        // console.log('/node/status response:', selNode )
        if( selNode.blockchainHeight <= this.blockchain.height() )
            return { error: false }  // same height, nothing more to do.

        console.log( `[${selNode.hostname}] has a longer blockchain (${selNode.blockchainHeight})` )
        const latestBlock = this.blockchain.getLatestBlock()
        const nodeMatchBlock = selNode.blockchain.pop()
        // console.log( `our us:them #${latestBlock.index}:${nodeMatchBlock.index} hash(${latestBlock.hash}:${nodeMatchBlock.hash})`)

        // if node's block at same height as ours matches, we can safely continue to build blockchain with it
        if( nodeMatchBlock.index !== latestBlock.index || nodeMatchBlock.hash !== latestBlock.hash ){
            this.peers = this.peers.filter( node => node.hostname !== selNode.hostname )
            console.log( ` x Node (${selNode.hostname}) has more blocks, but MISMATCHING index/hash @ #${latestBlock.index}, DE-peering` )
            return { error: `Node (${selNode.hostname}) has more blocks, but MISMATCHING index/hash @ #${latestBlock.index}, DE-peering` }
        }

        console.log( ` > their chain matches to my height (${latestBlock.index}), requesting MORE (/blocks?fromIndex=${latestBlock.index})...`)
        let newBlocks = 0
        try {
            const response = await urlCall({ hostname: selNode.hostname, path: `/blocks?fromIndex=${latestBlock.index}` })
            if( response.error ) return response

            newBlocks = this.blockchain.addBlockchain(response.result)
        } catch (e) {
            console.error(`Error with peer: ${e.message}`)
            return { error: e.message }
        }

        return { error: false, newBlocks }
    }

    async broadcastPeers({ path, data = '', peers = this.peers, all = false }) {
        const broadcastPeers = peers.filter( peer => (all || (peer.dir === 'out' && peer.pingNext < time())) ) // only those allowing ping
        console.log(`<< ${path} @ (${broadcastPeers.map( node => node.hostname ).join(',')})` )

        const requests = broadcastPeers.map(async (peer, idx) => {
            const request = { hostname: peer.hostname || peer, path }
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
                        .then( response => this.minerAnnounceProcess(response) )
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

    // process new block and update ledger of balances
    ledgerBalances( blockIdx=0 ) {
        // scan each block, then generate transactions for each entry
        if( blockIdx>0 ){
            this.blockchain.chain[blockIdx].transactions.forEach( transaction => this.ledger.transaction(transaction) )
        } else {
            console.log( `\n\n[ledgerBalances] building...` )
            this.blockchain.chain.forEach( block => {
                console.log( `- [block#${block.index}]: -----------------------------------` )
                block.transactions.forEach( transaction => this.ledger.transaction(transaction) )
            })
        }
    }

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
            const chkSeq = this.ledger.getTransactionSeq(srcWallet.publicKey)
            if( Number(seq) !== chkSeq+1 ){
                console.log( `Invalid src sequence (seq=${seq}), expected ${chkSeq+1}` )
                return { error: `Invalid src sequence (seq=${seq}), expected ${chkSeq+1}`, seq: chkSeq+1 }
            }

            // verify there are excess pending from this src, reject it
            const transSrc = this.ledger.buildNameKey(src, srcWallet.publicKey)
            const pendingSrcCnt = this.pendingTransactions.filter( t => t.src === transSrc ).length
            console.log( `  ~ total transactions queued by user (${transSrc}): ${pendingSrcCnt}` )
            if( pendingSrcCnt>16 ) {
                return { error: `Sorry too many transactions by user (${src}). Please resubmit later once blocks mined.` }
            }
            fee = this.transactionFee({ amount, fee })
        }

        // issue a stake request as it came through us
        const txStake = `${this.nodeName}:${time()}`
        const newTransaction = this.ledger.transaction({src, dest, amount, fee, seq, txSig, hash, ...data, txStake})
        
        // queue it if no error
        if( !newTransaction.error )
            this.pendingTransactions.push( newTransaction )

        return newTransaction
    }

    pruneTransactions( block ){
        console.log( `[pruneTransactions]: `, block.transactions)
        const txSigSet = block.transactions.filter(item => item.txSig !== undefined).map(item => item.txSig); 
        console.log( `block txSigSet:`, txSigSet )

        for( let i=0; i<this.pendingTransactions; i++ ){
            if( txSigSet.includes(this.pendingTransactions[i].txSig) ){
                console.log( ` - found #${this.pendingTransactions[i].txSig}, pruning`)
                delete this.pendingTransactions[i]
            }
        }
    }


    mine() {
        let transactions = []
        let errorTransactions = []
        let rewardTransactions = []

        const minePendingTransactions = () => {
        switch( this.workerStatus ){
            case 'IDLE':
                console.log( `*** MINING START ***`)
                const calc = this.blockchain.calcMiningReward(this.blockchain.height())
                this.blockchain.miningReward = calc.miningReward
                this.blockchain.difficulty = calc.difficulty

                // gather all the transaction fees that will now be assigned to this miner (they had been submitted to mint)
                this.pendingTransactions.forEach( t => {
                    delete t.txStake // once block created, no need for staking claim - it's only for decision time towards block creation
                    if( t.fee>0 ) 
                        rewardTransactions.push( this.ledger.transaction(
                        { src: '_mint', dest: this.nodeName, amount: t.fee, type: 'miningFees', source: t.hash } ) )
                })

                // block mining reward
                if( this.blockchain.miningReward>0 )
                    rewardTransactions.push( this.ledger.transaction(
                    { src: '_mint', dest: this.nodeName, amount: this.blockchain.miningReward, type: 'miningReward' }))
                
                // Create a new block with pending transactions, include calculated rewards mining server will get if this block accepted by other nodes
                // generate merkleRoot
                // let block = false
                transactions = [ ...this.pendingTransactions, ...rewardTransactions ]
                errorTransactions = transactions.filter( t => t.error )

                // no errors, great build markleTree and add block
                if( errorTransactions.length > 0 ){
                    this.workerStatus = 'UNDO'
                    break
                }

                const [ merkleRoot ]= this.blockchain.merkleBuild( transactions ).pop()

                const blockData = {
                    merkleRoot,
                    transactions
                }
                // transaction as "n/unconfirmed" until the transaction is 6 blocks deep
                const { block } = this.blockchain.addBlock(blockData, { minePoW: true })
                
                // offload to worker thread to solve (keeps system responsive)
                this.workerStatus = 'MINING'
                this.workerBlock = {}
                this.worker.postMessage({action: 'MINE', block, difficulty: this.blockchain.difficulty});
                break
        
            case 'MINING':
                console.log( ' ~ [Miner] checking in, worker still mining' )
                break;

            case 'SOLVED':
                const result = this.blockchain.addBlock(this.workerBlock)
                if( result.error ){
                    this.workerStatus = 'UNDO'
                    break
                }

                // reset our working transactiong
                // TODO figure out better BUGBUG
                transactions = []
                errorTransactions = []
                rewardTransactions = []

                // all pending are now in our blockclain - clear them
                this.pendingTransactions = []
                // this.pruneTransactions(newBlock)
                if( result.block )
                    this.broadcastPeers({ path: '/blocks/announce', data: [result.block], all: true })

                // ready to tackle another block
                this.workerStatus = 'IDLE'
                break

            case 'UNDO_BLOCK':
                transactions.forEach( t=>errorTransactions.push( t ) )
                console.log( `CRITICAL ERROR: Mined a block (${this.pendingTransactions.length} transactions), `
                            +`but unable to add it (reversing pending transactions) error: ${result.error}`)

            case 'UNDO':
                if( errorTransactions.length>0 ){
                    const error = errorTransactions.map( t => t.error || '' ).join(';').trim()
                    
                    console.log( `CRITICAL ERROR: ${error}` ) //errorTransactions
                    
                    // if any have erros with hashes, let's undo those transactions (likely the addBlock one)
                    const undoHashes = errorTransactions.filter( t => t.hash ).map( t => t.hash )
                    // console.log( 'undoHashes: ', undoHashes )
                    if( undoHashes.length>0 ){
                        const undoTransactions = this.pendingTransactions.filter( tx => undoHashes.includes(tx.hash) )
                        // console.log( 'undoTransactions', undoTransactions )
                        if( undoTransactions.length>0 ){
                            undoTransactions.forEach( transaction =>{
                                this.rejectedTransactions.push( transaction )
                                this.rejectedTransactions.push( this.ledger.transactionReverse( transaction ) )
                                })
                            // drop from pending transactions too
                            this.pendingTransactions = this.pendingTransactions.filter( tx => !undoHashes.includes(tx.hash) )
                            // TODO: if it was staked to me, I should notify all I'm dropping it
                        }
                    }
                    // reversing transactions
                    rewardTransactions.filter( t => !t.error ).forEach( transaction =>{
                        // console.log( `rewardTransaction: `, transaction )
                        this.rejectedTransactions.push( transaction )
                        const result =  this.ledger.transactionReverse( transaction )
                        // console.log( ` .. reversed: `, transaction, result )
                        this.rejectedTransactions.push( result )
                        })
                }
                break
            }

            // Update ledger balances using minted block, and change in transactions
            // this.ledgerBalances( newIndex )
        } 
        
        setInterval(() => {
            if (this.pendingTransactions.length > 0) {
                // console.log('Mining new block to integrate transactions into...')
                minePendingTransactions()
            }
        }, 10000); // Try to mine a new block every minute, simulating delay that real miner has tackling complex PoW calcs
    }
}