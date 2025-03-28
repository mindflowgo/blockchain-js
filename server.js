/**************************************************************************
 * Simple Fully Functional Blockchain Example
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
import { urlCall, fixRounding, time, sha256Hash, waitReady, handleGET, handlePOST, debug } from './lib/helper.js'
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

let dataPath = './data'

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
        const miner = new Miner({ nodeName, host, port, hosts, dataPath });
        miner.blockchain.compress = flags !== 'debug'

        // now run webserver to engage with network
        uWS.App({ /* cert_file_name: cert, key_file_name: key */})
        .get('/blocks', handleGET((res, req) => {
            debug('dim', `>> [${req.nodeToken}]${req.url}`)
            const fromIndex = Number(req.query.fromIndex || 0)
            const type = ['hashes','meta'].includes(req.query.type) ? req.query.type : ''
            const result = miner.blockchain.getBlockchain(fromIndex, 100, type)
            res.end( JSON.stringify({ error: false, result }) )
            }, miner.nodeState))
        
        .get('/node/wallets', handleGET((res, req) => {
            debug('dim', `>> [${req.nodeToken}]${req.url}:`)
            const wallets = req.query.wallets === 'ALL' ? [] : req.query.wallets.split(',')
            const result = miner.ledger.walletBalances(wallets)
            res.end( JSON.stringify({ error: false, result }) )
            }, miner.nodeState))

        .get('/transactions/verify', handleGET((res, req) => {
            debug('dim', `>> [${req.nodeToken}]${req.url}?${req.getQuery()}`)

            let result = []
            if( req.query.hash ){
                const hashes = req.query.hash.split(',')
                hashes.forEach( hash => {
                    // find in the transaction hash for speed (vs scanning blocks)
                    const hashInfo = miner.blockchain.transactionHashes[hash]
                    if( hashInfo?.index && hashInfo.index > 0 ){
                        const block = miner.blockchain.getBlock(hashInfo.index)
                        const { proof, merkleRoot } = miner.blockchain.merkleProof(block.transactions, hash)
                        result.push({ hash, block: { index: block.index, timestamp: block.timestamp }, merkleRoot, proof })

                    } else {
                        result.push({ error: `Invalid hash ${hash}`, hash, block: false })                        
                    }
                })
            }
            res.end( JSON.stringify({ error: false, result }) )
            }, miner.nodeState))

        .get('/transactions/pending', handleGET((res, req) => {
            debug('dim', `>> [${req.nodeToken}]${req.url}?${req.getQuery()}`)

            let result = miner.transactionManager.getPending()
            res.end( JSON.stringify({ error: false, result }) )
            }, miner.nodeState))

        .get('/transactions', handleGET((res, req) => {
            debug('dim', `>> [${req.nodeToken}]${req.url}?${req.getQuery()}`)

            let result = [], error = ''
            if( req.query.hash ){
                const hashes = req.query.hash.split(',')
                hashes.forEach( hash => {
                    const hashResult = miner.transactionManager.hashes[hash]
                    if( hashResult.error ) error += hashResult.error
                    if( hashResult.index > -1 ){
                        const block = miner.blockchain.getBlock(hashResult.index)
                        const transaction = block.transactions.filter( t => t.hash === hash )
                        if( transaction.length === 1 )
                            result.push( { ...transaction[0], meta: { blockIdx: block.index } } )
                    }
                })
            }
            res.end( JSON.stringify({ error: false, result }) )
            }, miner.nodeState))
            
        .post('/node/announce', handlePOST(async (info,head) => {
            debug( 'dim', `>> [${head.nodeToken}]${head.url} hostname(${info.hostname.replace('http://localhost:','')}) type(${info.type}) blockchainHeight(${info.blockchainHeight}) pendingTransactions(${info.pendingTransactionsCnt}) peers(${info.peers.join(',').replaceAll('http://localhost:','')})` )

            // include the post contactee, and add to our peer list
            info.peers.push( info.hostname ) 
            miner.addPeerHosts( info.peers )

            // they sent index/hash of their latest block, we'll send our hash for that block
            return { error: false, ...miner.pingInfo(info.blockAtHeight.index) }
            }, miner.nodeState))

        .post('/blocks/announce', handlePOST(async (blocks,head) => {
            debug( 'cyan', `>> [${head.nodeToken}]${head.url} #${blocks.map(b=>b.index).join(',')}` )

            miner.stateOffline('ADD_CHAIN')
            // prevent attempting to write it till we know if this announced block added
            if( miner.worker.status === 'MINING' ){
                debug( 'yellow', `   \_ pausing our mining`)
                miner.worker.status = 'MINING_PAUSE' 
            }
            // this only allows announced blocks that would chronologically fit onto our chain; in the event, 
            // our chain is off (or theirs), we simply ignore the block announcement -- we re-sync chains in 
            // heartbeat process
            let blockMaxIndex = miner.blockchain.height()
            let blockIdxSequenceOk = true
            blocks.forEach( block => {
                // only accept announcement blocks that are chronological to our blockchain height
                debug( 'cyan', `  ~ processing incoming block #${block.index} (our height()=${miner.blockchain.height()})` )
                if( block.index === blockMaxIndex++ ){
                    block.transactions.forEach( t => {
                        // console.log( ` block trans: ${t.src.split(':')[0]}/${t.seq}` )
                        const conflictTransaction = miner.transactionManager.pending.filter( pT => pT.src === t.src && pT.seq > 0 && pT.seq === t.seq && pT.hash !== t.hash )
                        const matchTransaction = miner.transactionManager.pending.filter( pT => pT.src === t.src && pT.seq === t.seq && pT.hash === t.hash )
                        if( conflictTransaction.length > 0 ){
                            debug( 'red', `  ! announced transaction (${t.src.split(':')[0]}/${t.seq}) CONFLICTS with one of ours (same user/seq), ours' hash: ${t.hash} ; ours will stale out when this block#${block.index} added.` )
                            if( conflictTransaction[0].meta.miner.indexOf(' MINING:')>0 )
                                debug( 'red', `  ~ in fact, we were already attempting to mine SAME our version: ${conflictTransaction[0].meta.miner}`)
                                
                            // miner.transactionReverse(conflictTransaction[0], { clearPending: true }) // don't bother revesing, it will stale-out
                        } else if( matchTransaction.length > 0 ){
                            debug( 'dim', ` .. incoming block #${block.index} transaction matches a pending transaction we have (good)` )
                        }
                    })
                } else {
                    blockIdxSequenceOk = false
                    debug( 'red', `    ! addBlockchain will skip block #${block.index}, expecting next block to be ${blockMaxIndex-1}. No problem: we will re-sync chain later.`)
                    if( block.index > blockMaxIndex ){
                        // bigger so lets' request update from them.
                        debug('dim', ` .. getting peer blocks from ${head.hostname} as they have more than us!`)
                        const syncResult = miner.syncPeerBlocks(head.hostname)
                        if( syncResult.error ) debug( 'red', syncResult.error )
                    }
                }
            })

            // only bother trying to add block if next in sequence
            let addResult = {}
            if( blockIdxSequenceOk ){
                addResult = miner.blockchain.addBlockchain(blocks)
                if( addResult.error ){
                    miner.worker.status = miner.worker.status.replace('_PAUSE','') // ex. 'MINING_PAUSE|SOLVE_PAUSE => MINING|SOLVE
                    miner.stateOnline()
                    return addResult
                }

                // remove any that were lingering in the pendingTransactions; go online again
                const { hashes, resetLedger }= addResult
                if( resetLedger ) debug('red', `The ledger should NEVER be reset during a simple block addition. Pending are ignored.`)
                miner.transactionManager.deletePending({ hashes })
            }
            miner.stateOnline()

            // if we are mining same block, cancel our block (we could leave it to finish, 
            // then discover block already exists, but wasted CPU)
            if( (miner.worker.status.indexOf('_PAUSE') > -1 ) ){
                debug( 'yellow', `**MINING-STOP** Incoming mined-block SAME index #${blocks[0].index} as ours (our completion state: ${miner.worker.status}), `
                            +`aborting/cleaning-up our mining effort; reversing transactions.` )
                miner.worker.node.postMessage({action: 'ABORT' })
                // // wait for worker to reverse the block, transactions, etc.
                // await waitReady(miner, 'worker', 'status', 'READY')
            }

            const { addBlockCnt, transactionCnt }= addResult
            return { addBlockCnt, transactionCnt }
            }, miner.nodeState))

        .post('/transactions/announce', handlePOST(async (transactions,head) => {
            let result = miner.transactionManager.newBatch( transactions )

                return { result }
            }, miner.nodeState))

        .post('/transactions/expired', handlePOST(async (transactions,head) => {
            let result = []
            transactions.forEach( t => {
                debug( `>> [${head.nodeToken}]${head.url} (${t.src.split(':')[0] || t.src}/${t.seq}) -> (${t.dest.split(':')[0] || t.dest}) amount(${t.amount}):` )
                const transResult = miner.transactionManager.transactionReverse( t, { clearPending:true })
                result.push( transResult )
                if( transResult.error ){
                    debug( 'red', `ERROR! ${transResult.error}}` )
                } else {
                    // broadcast it onward to peers if it was valid, and we killed it.
                    // this.broadcastPeers({ path: '/transactions/expired', data: [t], all: true })
                    debug( 'blue', `- Expired transaction ${t.src.split(':')[0]}/${t.seq} > ${t.dest.split(':')[0]} $${t.amount}, miner(${t.miner}) and relaying onward it's gone.)` )
                }
                })
                return { result }
            }, miner.nodeState))

        .post('/transactions', handlePOST(async (transactions,head) => { // user initiated transaction to server
            // came through us, stake ownership in minting them
            transactions.forEach( t => {
                if( !t.meta ) t.meta = {}
                if( !t.meta.miner ){
                    t.meta.miner = miner.nodeName
                    t.meta.minerStart = time()
                }
            })
            
            const response = miner.transactionManager.newBatch(transactions)
            // let result = []
            if( response.error ) return response

            response.result.forEach( (t,idx) => {
                // show transaction attempted
                const { src, dest, seq, amount, hash, meta }= transactions[idx]
                debug( 'cyan', `>> [${head.nodeToken||'API'}]${head.url} (${src.split(':')[0]}/${seq||'-'}) amount(${amount})  ${JSON.stringify(meta) || ''}`)

                // show result if error, else just broadcast it to peers
                const { error, fee, seq: postSeq, hash: postHash, balance }= t
                if( error ) {
                    debug('red',`   x Rejected: ${error}`)
                } else { 
                    // mempool transactions once accepted, are broadcast widely so others can get the balance+seq for that user
                    miner.broadcastPeers({ path: '/transactions/announce', data: [t] })
                }
            })

            // console.log( `[transaction] result:`, result )
            return { result: response.result }
            }, miner.nodeState))

        // get fee and seq #
        .post('/transactions/prepare', handlePOST(async (queries,head) => {
            debug('dim',`>> [${head.nodeToken}]${head.url}` )
            let result = []
            queries.forEach( ({ src, amount })=> {
                // now try to complete transaction
                const fee = miner.transactionManager.getFee({ amount })
                const srcWallet = miner.ledger.getWallet( src )
                if( srcWallet.error ){
                    result.push( srcWallet )
                } else {
                    const seq = srcWallet.tx.seq
                    if( seq.error )
                        result.push( seq )
                    else
                        result.push( { fee, seq, publicKey: srcWallet.publicKey })
                }
            })
            return { result }
            }, miner.nodeState))
                        
        .post('/node/wallets', handlePOST(async (wallets,head) => {
            let result = []
            wallets.forEach( walletData => {
                const name = walletData.name
                const updateWallet = miner.ledger.updateWallet(name, walletData)
                result.push({ name, error: updateWallet.error })
            })
            debug( `>>${head.nodeToken}${head.url} result:`, result )
            return { result }
            }, miner.nodeState))

        .any('/*', (res, req) => {
            /* Wildcards - make sure to catch them last */
            res.end( JSON.stringify({ error: `Invalid request: '${req.getUrl()}'` }) )
            })
            
        .listen(host, port, (token) => {
            if (token) {
                // port = uWS.us_socket_local_port(token)
                debug('green', `Miner running on ${host}:${port}; Miner discovering peers (${miner.nodeState})
                    `)
            } else {
                debug('red', 'Failed finding available port')
                process.exit(-1)
            }
        })
    }

    main().catch(err => {
        debug('red',err)
    })
}
