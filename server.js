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
import { urlCall, fixRounding, time, sha256Hash, waitReady, handleGET, handlePOST } from './lib/helper.js'
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
        console.log( "MINER Process, run from terminal:" )
        console.log( "node miner.js [debug|prod] [nodeName] [port] [peers: IP:port,IP:port]")
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
            console.log(`>> [${req.nodeToken}]${req.url}`)
            const fromIndex = Number(req.query.fromIndex) + 1
            const result = miner.blockchain.getBlockchainHashes(fromIndex, 100)
            res.end( JSON.stringify({ error: false, result }) )
            }, miner.nodeState))

        .get('/blocks', handleGET((res, req) => {
            console.log(`>> [${req.nodeToken}]${req.url}`)
            const fromIndex = Number(req.query.fromIndex) + 1
            const result = miner.blockchain.getBlockchain(fromIndex, 100)
            res.end( JSON.stringify({ error: false, result }) )
            }, miner.nodeState))
        
        .get('/node/wallets', handleGET((res, req) => {
                console.log(`>> [${req.nodeToken}]${req.url}:`)
                const wallets = req.query.wallets === 'ALL' ? [] : req.query.wallets.split(',')
                const result = miner.ledger.walletBalances(wallets)
                res.end( JSON.stringify({ error: false, result }) )
                }, miner.nodeState))

        .get('/transactions/verify', handleGET((res, req) => {
            console.log(`>> [${req.nodeToken}]${req.url}?${req.getQuery()}`)

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


            .get('/node/status', handleGET((res, req) => {
                const [ blockchainHeight, blockHash ]= req.query.bH.split(':')
                console.log(`>> [${req.nodeToken}]${req.url}?${req.getQuery()} blockchainHeight(${blockchainHeight})`)
    
                const response = {
                    nodeName: miner.nodeName,
                    nodeState: miner.nodeState,
                    timestamp: time(),
                    pendingTransactionsCnt: miner.pendingTransactions.length,
                    blockchainHeight: miner.blockchain.height(),
                    blockAtHeight: {}
                }
    
                // if requestee less height, give the hash for THEIR last block (for them to verify against)
                if( blockchainHeight <= miner.blockchain.height() ){
                    const { index, hash }= miner.blockchain.getBlock(blockchainHeight)
                    response.blockAtHeight = { index, hash }
                }
    
                // if their BH is more, ask for their blocks!
                if( blockchainHeight > miner.blockchain.height() ){
                    console.log( ` .. we should be getting their additional blocks!`)
                    miner.syncMissingBlocks()
                }
                res.end( JSON.stringify({ error: false, ...response }) )
                }, miner.nodeState))
                            
        .post('/node/announce', handlePOST(async (info,head) => {
            console.log( `>> [${head.nodeToken}]${head.url} hostname(${info.hostname}) type(${info.type}) blockchainHeight(${info.blockchainHeight}) peers(${info.peers.join(',')})` )

            // include the post contactee, and add to our peer list
            info.peers.push( info.hostname ) 
            miner.addPeerHosts( info.peers )

            // they sent index/hash of their latest block, we'll send our hash for that block
            return { error: false, ...miner.pingInfo(info.blockAtHeight.index) }
            }, miner.nodeState))

        .post('/blocks/announce', handlePOST(async (blocks,head) => {
            console.log( `>> [${head.nodeToken}]${head.url} #${blocks.map(b=>b.index).join(',')}` )

            miner.nodeState = 'LOADING'
            const addResult = miner.blockchain.addBlockchain(blocks)
            if( addResult.error ) return addResult

            const { addBlockCnt, transactionCnt }= addResult
            miner.nodeState = 'ONLINE'

            // if we are mining same block, cancel our block (we could leave it to finish, 
            // then discover block already exists, but wasted CPU)
            if( miner.workerStatus === 'MINING' && miner.workerBlock.index >= blocks[0].index ){
                console.log( `**CRAP** Incoming mined-block SAME index as ours, aborting our mining effort; reversing transactions.` )
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
                const { isNew, index } = miner.blockchain.findOrCreateHash( t.hash )
                if( isNew ){ 
                    // push into our transaction queue
                    miner.pendingTransactions.push( t )
                    // extract miner-meta-data, then calculate change to users balances
                    const { txStake, balance, ...transaction }= t
                    const transResult = miner.ledger.transaction(transaction) 
                    result.push( transResult )
                    const publicKey = miner.ledger.getPublicKey(transaction.src)
                    console.log( `>> [${head.nodeToken}]${head.url} txStake(${transResult.txStake}) amount(${miner.ledger.wallets[publicKey].amount})` ) // publicKey(${publicKey}), expected balance(${balance}) transaction: `, transResult )
                    if( !transResult.error && miner.ledger.wallets[publicKey].balance !== balance )
                        console.log( `ERROR! We successfully did transaction but it's balance (${miner.ledger.wallets[publicKey].balance}) is NOT what announcement said (${balance}) `)
                
                    // announce to anyone but the source
                } else {
                    console.log( ` x skipping transaction, already in system (${index})` )
                }
                })
                return { result }
            }, miner.nodeState))

        .post('/transactions/expired', handlePOST(async (transactions,head) => {
            let result = []
            transactions.forEach( t => {
                const transResult = miner.transactionReverse( t )
                result.push( transResult )
                console.log( `>> [${head.nodeToken}]${head.url} (${t.src.split(':')[0] || t.src}) -> (${t.dest.split(':')[0] || t.dest}) amount(${t.amount})` )
                if( transResult.error ){
                    console.log( `ERROR! ${transResult.error}}` )
                } else {
                    // broadcast it onward to peers if it was valid, and we killed it.
                    // this.broadcastPeers({ path: '/transactions/expired', data: [t], all: true })
                    console.log( `- Expired transaction, and relaying onward it's gone.)`,t )
                }
                })
                return { result }
            }, miner.nodeState))

        .post('/transactions', handlePOST(async (transactions,head) => {
            let result = []
            for( const transactionData of transactions ){
                const { src, dest, seq, amount, hash, txStake }= transactionData

                // now try to complete transaction
                console.log(`>> [${head.nodeToken}]${head.url} (${src.split(':')[0]}/${seq||'-'}) amount(${amount}) txStake(${txStake||'-'})`)
                
                // const { isNew, index }= miner.blockchain.findOrCreateHash(hash)
                // if( !isNew ){
                //     console.log( `   x rejecting transaction: already in our blockchain @ ${index>0 ? '#'+index : 'mempool'}: ${hash}`)
                //     result.push({ error: `Already in our blockchain @ #${index} with ${hash}` })
                //     continue
                // }
                const newTransaction = miner.transaction(transactionData) // includes miner meta-data (txStake, balance)
                // console.log( ` /transactions: newTransaction:`, newTransaction )
                const { error, fee, seq: postSeq, hash: postHash, balance }= newTransaction
                result.push({ error, hash: postHash, fee, seq: postSeq, balance })
                if( error ){
                    console.log( `   x Rejected: ${error}`)
                    result.push({ error, hash })
                    continue
                }

                // mempool transactions once accepted, are broadcast widely so others can get the balance+seq for that user
                console.log( `        ACCEPTED ${postHash} -> announcing to peers` )
                miner.broadcastPeers({ path: '/transactions/announce', data: [newTransaction], all: true })
            }
            // console.log( `[transaction] result:`, result )
            return { result }
            }, miner.nodeState))

        // get fee and seq #
        .post('/transactions/prepare', handlePOST(async (queries,head) => {
            console.log(`>> [${head.nodeToken}]${head.url}` )
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
            console.log( `>>${head.nodeToken}${head.url} result:`, result )
            return { result }
            }, miner.nodeState))

        .any('/*', (res, req) => {
            /* Wildcards - make sure to catch them last */
            res.end( JSON.stringify({ error: `Invalid request: '${req.getUrl()}'` }) )
            })
            
        .listen(host, port, (token) => {
            if (token) {
                // port = uWS.us_socket_local_port(token)
                console.log(`Miner running on ${host}:${port} ${miner.nodeState}`)
            } else {
                console.log('Failed finding available port')
                process.exit(-1)
            }
        })
    }

    main().catch(err => {
        console.log(err)
    })
}
