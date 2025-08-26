/**************************************************************************
 * Simple Fully Functional serverMiner.Blockchain Example
 * 
 * (c) 2025 Filipe Laborde, fil@rezox.com
 * 
 * MIT License
 * 
 * To illustrate how blockchain works with a simple but relatively fully
 * featured example works. A learning took to help you understand the 
 * complexity.
 * 
 * Original bitcoin paper: 
 * https://bitcoin.org/bitcoin.pdf
 * 
 * private key mnemoics: 
 * https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki
 */

import dotenv from 'dotenv'
import uWS from 'uWebSockets.js' // npm install uNetworking/uWebSockets.js#v20.51.0
// import WebSocket from 'ws';
import { handleGET, handlePOST, debug } from './lib/helper.js'

import Miner from './lib/Miner.js'

// let COMPRESS_BLOCKFILES = false
/* Bitcoin original paper notes:
5. Network
The steps to run the network are as follows:
1) New transactions are broadcast to all nodes.
2) Each node collects new transactions into a block.
3) Each node works on finding a difficult proof-of-work for its block.
4) When a node finds a proof-of-work, it broadcasts the block to all nodes.
5) Nodes accept the block only if all transactions in it are valid and not already spent.
6) Nodes express their acceptance of the block by working on creating the next block in the 
   chain, using the hash of the accepted block as the previous hash.

Nodes always consider the longest chain to be the correct one and will keep working on
extending it. If two nodes broadcast different versions of the next block simultaneously, some
nodes may receive one or the other first. In that case, they work on the first one they received,
but save the other branch in case it becomes longer. The tie will be broken when the next 
proof-of-work is found and one branch becomes longer;
*/

const DEBUG = 1

// if run from terminal, spawn up
if( process.argv.length>1 && process.argv[1].indexOf('server.js')>0 ){
    if( process.argv.length<4 ){
        debug( 'green', "MINER Process, run from terminal:" )
        debug( 'green', "node miner.js [debug|prod] [nodeName] [port] [peers: IP:port,IP:port]")
        process.exit()
    }

    // parameters passed in + defaults
    const flags = process.argv[2]
    const nodeName = process.argv[3]
    const host = 'localhost'
    let port = Number(process.argv[4]) || 3000
    let hosts = []
    if( process.argv[5] ) hosts = process.argv[5].includes(',') ? process.argv[5].split(',') : [ process.argv[5] ]

    async function main() {
        // start miner memory process
        const serverMiner = new Miner({ nodeName, host, port, hosts, dataPath: './data' })

        // now run webserver to engage with network
        uWS.App({ /* cert_file_name: cert, key_file_name: key */})
        .get('/blocks', handleGET((res, req) => {
            debug('dim', `>> [${req.nodeAuth}]${req.url}`)
            const fromIndex = Number(req.query.fromIndex || 0)
            const type = ['hashes','meta'].includes(req.query.type) ? req.query.type : ''
            const result = serverMiner.Blockchain.getChain(fromIndex, 100, type)
            res.end( JSON.stringify({ error: false, result }) )
            }, serverMiner.P2P.getNodeState()))
        
        .get('/node/wallets', handleGET((res, req) => {
            debug('dim', `>> [${req.nodeAuth}]${req.url}:`)
            const addresses = req.query.addresses === 'ALL' ? [] : req.query.addresses.split(',')
            const result = serverMiner.Wallet.balances(addresses)
            res.end( JSON.stringify({ error: false, result }) )
            }, serverMiner.P2P.getNodeState()))

        .get('/transactions/verify', handleGET((res, req) => {
            debug('dim', `>> [${req.nodeAuth}]${req.url}?${req.getQuery()}`)

            let result = []
            for( const hash of req.query.hash.split(',') ){
                // find in the transaction hash for speed (vs scanning blocks)
                const index = serverMiner.Mempool.Hashes.findBlockIdx(hash)
                if( !index ){
                    result.push({ error: `Invalid hash ${hash}`, hash, block: false })
                    continue
                }

                const block = serverMiner.Blockchain.getBlock(index)
                const { proof, merkleRoot } = serverMiner.TransactionHandler.merkleProof(block.transactions, hash)
                result.push({ hash, block: { index, timestamp: block.timestamp }, merkleRoot, proof })
            }
            res.end( JSON.stringify({ error: false, result }) )
            }, serverMiner.P2P.getNodeState()))

        .get('/transactions/pending', handleGET((res, req) => {
            debug('dim', `>> [${req.nodeAuth}]${req.url}?${req.getQuery()}`)

            let result = serverMiner.Mempool.Queue.getMinerSorted({ miner: serverMiner.nodeName })
            res.end( JSON.stringify({ error: false, result }) )
            }, serverMiner.P2P.getNodeState()))

        .get('/transactions', handleGET((res, req) => {
            debug('dim', `>> [${req.nodeAuth}]${req.url}?${req.getQuery()}`)

            let result = [], error = ''
            for( const hash of req.query.hash.split(',') ){
                const index = serverMiner.Mempool.Hashes.findBlockIdx(hash)
                if( index ){
                    const block = serverMiner.Blockchain.getBlock(index)
                    const transactions = serverMiner.TransactionHandler.filter({ transactions: block.transactions, hashes: [hash] })
                    if( transactions.length === 1 )
                        result.push( { ...transaction[0], meta: { blockIdx: index } } )
                }
            }
            res.end( JSON.stringify({ error: false, result }) )
            }, serverMiner.P2P.getNodeState()))
            
        .post('/node/announce', handlePOST(async (info,head) => {
            debug( 'dim', `>> [${head.nodeAuth}]${head.url} hostname(${info.hostname.replace('http://localhost:','')}) type(${info.type}) blockchainHeight(${info.blockchainHeight}) pendingTransactions(${info.pendingTransactionsCnt}) peers(${info.peers.join(',').replaceAll('http://localhost:','')})` )

            // include the post contactee, and add to our peer list
            info.peers.push( info.hostname ) 
            serverMiner.P2P.addPeerHosts( info.peers )

            // they sent index/hash of their latest block, we'll send our hash for that block
            return { error: false, ...serverMiner.P2P.pingInfo(info.blockAtHeight.index) }
            }, serverMiner.P2P.getNodeState() ))

        .post('/block/announce', handlePOST(async (block,head) => {
            debug( 'cyan', `>> [${head.nodeAuth}]${head.url} #${block.index}` )

            serverMiner.P2P.getNodeState('ADD_BLOCK')
            // prevent attempting to write it till we know if this announced block added
            serverMiner.MinerWorker.pauseMining()

            // only accept block announcements that chain onto our chain, ignore others.
            debug( 'cyan', `  ~ processing incoming block #${block.index} (our height()=${Blockchainheight()})` )
            if( block.index === serverMiner.Blockchain.height() ){
                block.transactions.forEach( t => {
                    // console.log( ` block trans: ${serverMiner.Wallet.getNameOnly(t.src)}/${t.seq}` )
                    const conflictTransaction = serverMiner.TransactionHandler.queue.filter( pT => pT.src === t.src && pT.seq > 0 && pT.seq === t.seq && pT.hash !== t.hash )
                    const matchTransaction = serverMiner.TransactionHandler.queue.filter( pT => pT.src === t.src && pT.seq === t.seq && pT.hash === t.hash )
                    if( conflictTransaction.length > 0 ){
                        debug( 'red', `  ! announced transaction [${serverMiner.Wallet.getNameOnly(t.src)}/${t.seq} -> ${serverMiner.Wallet.getNameOnly(t.dest)} $${t.amount}] CONFLICTS with one of ours (same user/seq), ours' hash: ${t.hash} ; ours will stale out when this block#${block.index} added.` )
                        if( conflictTransaction[0].meta.miner.indexOf(' MINING:')>0 )
                            debug( 'red', `  ~ in fact, we were already attempting to mine SAME our version: ${conflictTransaction[0].meta.miner}`)
                            
                        // miner.transactionReverse(conflictTransaction[0], { clearQueued: true }) // don't bother revesing, it will stale-out
                    } else if( matchTransaction.length > 0 ){
                        debug( 'dim', ` .. incoming block #${block.index} [${serverMiner.Wallet.getNameOnly(t.src)}/${t.seq} -> ${serverMiner.Wallet.getNameOnly(t.dest)} $${t.amount}] matches a pending we have (good)` )
                    }
                })
            } else if( block.index > serverMiner.Blockchain.height() ){
                // bigger so lets' request update from them.
                debug('dim', ` .. getting peer blocks from ${head.hostname} as they have more than us!`)
                const syncResult = serverMiner.P2P.syncPeerBlocks(head.hostname)
                if( syncResult.error ) debug( 'red', syncResult.error )
            } else {
                debug( 'red', `    ! addBlockchain will skip block #${block.index}, expecting next block to be ${blockMaxIndex-1}. No problem: we will re-sync chain later.`)
            }

            // only bother trying to add block if next in sequence
            let addResult = {}
            if( block.index === serverMiner.Blockchain.height() ){
                addResult = serverMiner.Blockchain.addBlock(block)
                if( addResult.error ){
                    // adding income block failed, let's finish ours (if paused)
                    serverMiner.MinerWorker.continueMining()
                    serverMiner.P2P.getNodeState('ONLINE')
                    return addResult
                }
            }
            serverMiner.P2P.getNodeState('ONLINE')

            // if we are mining same block, cancel our block (our miner will try again for next block)
            serverMiner.MinerWorker.stopMining()

            return addResult
            }, serverMiner.P2P.getNodeState() ))

        .post('/transaction/announce', handlePOST(async (transactions,head) => {
            let result = serverMiner.TransactionHandler.processTransaction( transaction )
            return { result }
            }, serverMiner.P2P.getNodeState()))

        .post('/transaction', handlePOST(async (transaction,head) => { // user initiated transaction to server
            // came through us, stake minting right
            serverMiner.TransactionHandler.updateMeta([transaction],'miner',serverMiner.nodeName)
            const response = serverMiner.TransactionHandler.processTransaction(transaction)

            // debug only BUGUG
            const { src, dest, seq, amount, hash, meta }= transaction
            debug( 'cyan', `>> [${head.nodeAuth||'API'}]${head.url} (${serverMiner.Wallet.getNameOnly(src)}/${seq||'-'}) amount(${amount})  ${JSON.stringify(meta) || ''}`)

            // let result = []
            if( response.error ) return response

            // mempool transactions once accepted, are broadcast widely so others can get the balance+seq for that user
            serverMiner.P2P.broadcastTransaction( transaction )                
                
            // console.log( `[transaction] result:`, result )
            return { result: response }
            }, serverMiner.P2P.getNodeState()))

        // get fee and seq #
        .post('/transaction/prepare', handlePOST(async ({src, amount },head) => {
            debug('dim',`>> [${head.nodeAuth}]${head.url}` )
            // now try to complete transaction
            const fee = serverMiner.TransactionHandler.getFee({ amount })
            const srcWallet = serverMiner.Wallet.getUser( src )
            if( srcWallet.error )
                return srcWallet
            
            const seq = srcWallet.seq.tx
            if( seq.error )
                return seq
            
            return { fee, seq, publicKey: srcWallet.publicKey }
            }, serverMiner.P2P.getNodeState()))
                        
        .post('/node/wallets', handlePOST(async (wallets,head) => {
            let result = []
            wallets.forEach( walletData => {
                const name = walletData.name
                const updateWallet = serverMiner.Wallet.updateWallet(name, walletData)
                result.push({ name, error: updateWallet.error })
            })
            debug( `>>${head.nodeAuth}${head.url} result:`, result )
            return { result }
            }, serverMiner.P2P.getNodeState()))

        // get fee and auth infoseq #
        .post('/token/auth', handlePOST(async (token,amount,action,head) => {
            let result = []
            // BUGBUG futurelogic for more complex token authorization could be added 
            // for now, we treat each token created as controlled by one entity
            const tokenWallet = serverMiner.Wallet.getUser(token, false)
            const fee = 0 // could be based on amount of currency
            result = { action, fee, tokenAdmin: !tokenWallet.error ? tokenWallet.tokenAdmin : '' }
            console.log( `head:`, head )
            debug( `>>${head.nodeAuth}${head.url} result:`, result )
            return { result }
            }, serverMiner.P2P.getNodeState()))
            // response = await urlCall({ hostname: url, path: '/token/auth', body: [{ token, amount, tokenAdmin }] })
                        
        .post('/token/create', handlePOST(async (token,supply,admin,head) => {
            let result = []
            const transactions = serverMiner.TransactionHandler.createToken(supply, token, admin)
            if( transactions.error ) return transactions

            // let's run this transaction
            const response = serverMiner.TransactionHandler.processTransactions(transactions)
            if( response.error ) return response
            debug( `>>${head.nodeAuth}${head.url} result:`, result )
            // return { response}
            return { result }
            }, serverMiner.P2P.getNodeState()))

        .post('/token/airdrop', handlePOST(async (transactions,head) => {
            // response = await urlCall({ hostname: url, path: '/token/airdrop', body: [{ token, amount, tokenAuth }] })
            const srcWallet = this.Wallet.getUser(token)
            // check that airdrop is authorized by token admin
            // const tokenAdmin = srcWallet.tokenAdmin
            // this.Wallet.decode(tokenAdmin, tokenAuth) === `${token}|${amount}|`
            // const tokenAuth = serverMiner.Wallet.
            // const transaction = { src: token, dest, amount, token, txSig = '', hash
            // processTransaction({src, dest, amount, token = '', fee = 0, seq = 0, txSig = '', hash = '', ...data}, options = {} ) {
            //     const { blockIdx = -1, txUpdate = false, manageMempool = true }= options

            //     createToken(supply, token = this.BASE_TOKEN, admin = this.nodeName){
                
            const response = serverMiner.TransactionHandler.processTransactions(transactions)
            // let result = []
            if( response.error ) return response


            }, serverMiner.P2P.getNodeState()))


            
        .any('/*', (res, req) => {
            /* Wildcards - make sure to catch them last */
            res.end( JSON.stringify({ error: `Invalid request: '${req.getUrl()}'` }) )
            })
            
        .listen(host, port, (ws_token) => {
            if (ws_token) {
                // port = uWS.us_socket_local_port(ws_token)
                debug('green', `Miner running on ${host}:${port}; Miner discovering peers`)
            } else {
                debug('red', 'Failed finding available port')
                process.exit(-1)
            }
        })
    }

    // process.on('unhandledRejection', (reason, promise) => {
    //     console.error('Unhandled Rejection at:', promise, 'reason:', reason.stack || reason);
    //   });

    main()
    // .catch(err => {
    //     debug('red',err)
    // })
}
