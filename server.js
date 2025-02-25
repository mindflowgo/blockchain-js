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
        .get('/blocks/hashes', handleGET((res, req) => {
            debug('dim', `>> [${req.nodeToken}]${req.url}`)
            const fromIndex = Number(req.query.fromIndex)
            const result = miner.blockchain.getBlockchainHashes(fromIndex, 100)
            res.end( JSON.stringify({ error: false, result }) )
            }, miner.nodeState))

        .get('/blocks', handleGET((res, req) => {
            debug('dim', `>> [${req.nodeToken}]${req.url}`)
            const fromIndex = Number(req.query.fromIndex)
            const result = miner.blockchain.getBlockchain(fromIndex, 100)
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
                            
        .post('/node/announce', handlePOST(async (info,head) => {
            debug( 'dim', `>> [${head.nodeToken}]${head.url} hostname(${info.hostname}) type(${info.type}) blockchainHeight(${info.blockchainHeight}) peers(${info.peers.join(',').replaceAll('http://localhost:','')})` )

            // include the post contactee, and add to our peer list
            info.peers.push( info.hostname ) 
            miner.addPeerHosts( info.peers )

            // they sent index/hash of their latest block, we'll send our hash for that block
            return { error: false, ...miner.pingInfo(info.blockAtHeight.index) }
            }, miner.nodeState))

        .post('/blocks/announce', handlePOST(async (blocks,head) => {
            debug( 'dim', `>> [${head.nodeToken}]${head.url} #${blocks.map(b=>b.index).join(',')}` )

            miner.nodeState = 'LOADING'
            // prevent attempting to write it till we know if this announced block added
            if( miner.workerStatus === 'MINING' ){
                debug( 'yellow', `  ! pausing our mining`)
                miner.workerStatus = 'MINING_PAUSE' 
            }
            // we may have a situation where this block will have transactions that override pendingTransactions
            // let's pro-actively create out those pendings so this works.
            if( miner.pendingTransactions.length>0 ) debug( 'dim', ` ...pendingTransactions: `, miner.pendingTransactions )
            let blockMaxIndex = miner.blockchain.height()
            blocks.forEach( block => {
                // only accept announcement blocks that are chronological to our blockchain height
                debug( 'dim', ` incoming block (#${block.index}/${block.hash}) miner.blockchain.height()='${miner.blockchain.height()}` )
                if( block.index === blockMaxIndex++ ){
                    block.transactions.forEach( t => {
                        console.log( ` block trans: ${t.src.split(':')[0]}/${t.seq}` )
                        const conflictTransaction = miner.pendingTransactions.filter( pT => pT.src === t.src && pT.seq === t.seq && pT.hash !== t.hash )
                        const matchTransaction = miner.pendingTransactions.filter( pT => pT.src === t.src && pT.seq === t.seq )
                        if( conflictTransaction.length > 0 ){
                            debug( 'red', ` .. conflict transaction, eliminating it before adding blockChain block #${t.index}`, conflictTransaction )
                            miner.transactionReverse(conflictTransaction)
                        } else if( matchTransaction.length > 0 ){
                            debug( ` .. match transaction, we found matching in blockChain block #${t.index}`, matchTransaction )
                        }
                    })
                } else {
                    debug( 'red', `    ! skipping block #${block.index}, expecting next block to be ${blockMaxIndex-1}`)
                }
            })
            const addResult = miner.blockchain.addBlockchain(blocks)
            if( addResult.error ){
                miner.workerStatus = miner.workerStatus.replace('_PAUSE','') // ex. 'MINING_PAUSE|SOLVE_PAUSE => MINING|SOLVE
                miner.nodeState = 'ONLINE'
                return addResult
            }

            // remove any that were lingering in the pendingTransactions; go online again
            const { addBlockCnt, hashes, transactionCnt }= addResult
            miner.prunePendingTransactions( hashes )
            miner.nodeState = 'ONLINE'

            // if we are mining same block, cancel our block (we could leave it to finish, 
            // then discover block already exists, but wasted CPU)
            if( (miner.workerStatus.includes('MINING') || miner.workerStatus.includes('SOLVED')) && 
                miner.workerBlock.index >= blocks[0].index ){
                debug( 'yellow', `**CRAP** Incoming mined-block SAME index as ours (our completion state: ${miner.workerStatus}), `
                            +`aborting/cleaning-up our mining effort; reversing transactions.` )
                miner.worker.postMessage({action: 'ABORT' })
                // wait for worker to reverse the block, transactions, etc.
                await waitReady(miner, 'workerStatus', 'READY')
                // while( miner.workerStatus !== 'READY' ){}
            }

            return { addBlockCnt, transactionCnt }
            }, miner.nodeState))

        .post('/transactions/announce', handlePOST(async (transactions,head) => {
            let result = []
            transactions.forEach( t => {
                // delete administrative fields (use these for decision making)
                const { error, isNew, index } = miner.blockchain.findOrCreateHash( t.hash )
                if( !error && isNew ){ 
                    // push into our transaction queue
                    miner.pendingTransactions.push( t )
                    // extract miner-meta-data, then calculate change to users balances
                    const { txStake, balance, ...transaction }= t
                    const transResult = miner.ledger.transaction(transaction) 
                    result.push( transResult )
                    const publicKey = miner.ledger.getPublicKey(transaction.src)
                    debug( `>> [${head.nodeToken}]${head.url} txStake(${transResult.txStake}) amount(${miner.ledger.wallets[publicKey].amount})` ) // publicKey(${publicKey}), expected balance(${balance}) transaction: `, transResult )
                    if( !transResult.error && miner.ledger.wallets[publicKey].balance !== balance )
                        console.log( `ERROR! We successfully did transaction but it's balance (${miner.ledger.wallets[publicKey].balance}) is NOT what announcement said (${balance}) `)
                
                    // announce to anyone but the source
                } else {
                    debug( 'dim', ` x skipping transaction, already in system (${index}): ${error||''}` )
                }
                })
                return { result }
            }, miner.nodeState))

        .post('/transactions/expired', handlePOST(async (transactions,head) => {
            let result = []
            transactions.forEach( t => {
                debug( `>> [${head.nodeToken}]${head.url} (${t.src.split(':')[0] || t.src}/${t.seq}) -> (${t.dest.split(':')[0] || t.dest}) amount(${t.amount}):` )
                const transResult = miner.transactionReverse( t )
                result.push( transResult )
                if( transResult.error ){
                    debug( 'red', `ERROR! ${transResult.error}}` )
                } else {
                    // broadcast it onward to peers if it was valid, and we killed it.
                    // this.broadcastPeers({ path: '/transactions/expired', data: [t], all: true })
                    debug( 'blue', `- Expired transaction, and relaying onward it's gone.)`,t )
                }
                })
                return { result }
            }, miner.nodeState))

        .post('/transactions', handlePOST(async (transactions,head) => {
            let result = []
            for( const transactionData of transactions ){
                const { src, dest, seq, amount, hash, txStake }= transactionData

                // now try to complete transaction
                debug( 'dim', `>> [${head.nodeToken}]${head.url} (${src.split(':')[0]}/${seq||'-'}) amount(${amount}) txStake(${txStake||'-'})`)
                
                const newTransaction = miner.transaction(transactionData) // includes miner meta-data (txStake, balance)
                const { error, fee, seq: postSeq, hash: postHash, balance }= newTransaction

                result.push({ error, hash: postHash, fee, seq: postSeq, balance })
                if( error ){
                    console.log( `   x Rejected: ${error}`)
                    result.push({ error, hash })
                    continue
                }

                // mempool transactions once accepted, are broadcast widely so others can get the balance+seq for that user
                debug( `        ACCEPTED ${postHash} -> announcing to peers` )
                miner.broadcastPeers({ path: '/transactions/announce', data: [newTransaction], all: true })
            }
            // console.log( `[transaction] result:`, result )
            return { result }
            }, miner.nodeState))

        // get fee and seq #
        .post('/transactions/prepare', handlePOST(async (queries,head) => {
            debug('dim',`>> [${head.nodeToken}]${head.url}` )
            let result = []
            queries.forEach( ({ src, amount })=> {
                // now try to complete transaction
                const fee = miner.transactionFee({ amount })
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
                debug('green', `Miner running on ${host}:${port} ${miner.nodeState}`)
            } else {
                debug('red', 'Failed finding available port')
                process.exit(-1)
            }
        })
    }

    main().catch(err => {
        console.log(err)
    })
}
