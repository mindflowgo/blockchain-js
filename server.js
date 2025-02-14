/**************************************************************************
 * Simple Fully Functional Blockchain Example
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
import { urlCall, fixRounding, time, sha256Hash, handleJSON } from './lib/helper.js'
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
    let nodes = []
    if( process.argv[5] ) nodes = process.argv[5].includes(',') ? process.argv[5].split(',') : [ process.argv[5] ]

    async function main() {
        // start miner memory process
        const miner = new Miner({ nodeName, host, port, nodes, dataPath });
        miner.blockchain.compress = flags !== 'debug'

        // now run webserver to engage with network
        uWS.App({ /* cert_file_name: cert, key_file_name: key */})
        .get('/blocks', (res, req) => {
            const params = Object.fromEntries(new URLSearchParams(req.getQuery()))

            // const remoteIP = res.getRemoteAddressAsText() // res.getProxiedRemoteAddressAsText()).toString()
            // const fromIndex = req.getParameters('fromIndex')
            const fromIndex = Number(params.fromIndex) + 1
            // console.log( `>> /blocks?fromIndex=${fromIndex}\n<< [${miner.nodeName}] blockchain`)
            // send 100 blocks at a time...
            res.end( JSON.stringify({ error: false, result: miner.blockchain.getBlockchain(fromIndex, 100) }) )
            // const res = await httpsPost({ path: `/api/`, body: JSON.stringify({}) })
            })

        .get('/node/status', (res, req) => {
            // const remoteIP = res.getRemoteAddressAsText() // res.getProxiedRemoteAddressAsText()).toString()
            const params = Object.fromEntries(new URLSearchParams(req.getQuery()))
            const blockchainHeight = params.bH // const blockchainHeight = req.getParameter('len')
            // console.log( `<< [/node/status] params blockchainHeight(${blockchainHeight})` )

            const response = {
                timestamp: time(),
                blockchainHeight: miner.blockchain.height(),
                blockchain: []
            }

            // check we include their blockchainHeight item, include it
            // they can verify chains match to that point, and request future blocks
            if( blockchainHeight <= miner.blockchain.height() ){
                const block = miner.blockchain.chain[blockchainHeight]
                response.blockchain.push({ index: block.index, hash: block.hash })
            }

            // console.log( `[${miner.nodeName}] << /node/heartbeat | responded.`)
            res.end( JSON.stringify({ error: false, ...response }) )
            // const res = await httpsPost({ path: `/api/`, body: JSON.stringify({}) })
            })
        
        .get('/transactions/verify', (res, req) => {
            const params = Object.fromEntries(new URLSearchParams(req.getQuery()))
            
            let result = []
            if( params.hash ){
                const hashes = params.hash.split(',')
                hashes.forEach( hash => {
                    // scan blocks for hash
                    for( let i=0; i<=miner.blockchain.height(); i++ ){
                        const block = miner.blockchain.chain[i]
                        const matchTransaction = block.transactions.filter( tx => tx.hash === hash )
                        if( matchTransaction.length === 1 ){
                            // found; generate merkleProof and gather for client
                            const { proof, merkleRoot } = miner.blockchain.merkleProof(block.transactions, hash)
                            result.push( { hash, block: { index: block.index, timestamp: block.timestamp }, merkleRoot, proof } )    
                            break
                        }
                    }
                })
            }
            res.end( JSON.stringify({ error: false, result }) )
            // const res = await httpsPost({ path: `/api/`, body: JSON.stringify({}) })
            })
        // curl --data '{"src":"test","dest":"tome","amount":"33"}' http://localhost:5000/transaction

        .post('/node/announce', handleJSON(async (info) => {
            console.log( `>> /node/announce miner(${info.nodeName}) hostname(${info.hostname}) type(${info.type}) blockchainHeight(${info.blockchainHeight}) peers(${info.peers.join(',')})` )
            // respond to their blockchain info

            info.peers.push( info.hostname ) // include the contactee
            miner.addPeers( info.peers )
            // console.log( ` ... peers: `, miner.peers )
            // their latest block - it comes as blockchain: [{ index: 12, hash: 000000 }]
            // we'll get our hash for that block and send back, as well as our latest block
            const queryBlock = info.blockchain.pop()
            // console.log( `queryBlock(${queryBlock.index}) info.blockchain:`, info.blockchain )
            // const idx = this.peers.findIndex( item => item.nodeName ===params.nodeName )
            // this.peers[idx] = peers.map( peer =>{ return { hostname: peer, heartbeat: 0, nodeName: '', blockchainHeight: 0 } })
            // blockchain: { index: this.blockchain.getLatestBlock().index, hash: this.blockchain.getLatestBlock().hash }
            return { error: false, ...miner.minerAnnounceInfo(queryBlock.index) }
            }))

        .post('/blocks/announce', handleJSON(async (blocks) => {
            // console.log( `>> /blocks/announce: `, blocks )
            let result = []
            blocks.forEach( block => {
                if( block.index && !block.error ){
                    // console.log( `>> /blocks/announce block:`, block)
                    const newBlock = miner.blockchain.addBlock(block)
                    // console.log( `  newBlock: `, newBlock.block )
                    if( !newBlock.error ) {
                        // blocks.push( newBlock )
                        // run the ransactions from it
                        newBlock.block.transactions.forEach( t => {
                            const { isNew, index } = miner.blockchain.findOrCreateHash( t.hash, newBlock.index )
                            console.log( `  ..findOrCreateHash[${t.hash}]: isNew(${isNew}) index(${index})`)
                            if( isNew ) // process it
                                miner.ledger.transaction(t)
                            else 
                                console.log( ` x skipping block transaction, already in system (${index})` )
                        })
                        // remove those transactions from any blocks we are mining!
                        // miner.pruneTransactions(newBlock)
                    }
                }
            })

            // any pending transactions now published in block can be pruned
            // miner.pruneTransactions(newBlock)
            return { result }
            }))

        .post('/transactions/announce', handleJSON(async (transactions) => {
            let result = []
            transactions.forEach( transactionData => {
                console.log( ` got an announcement for `, transactionData )
            })
            return { result }
            }))

        .post('/transactions', handleJSON(async (transactions) => {
            let result = []
            transactions.forEach( transactionData => {
                // now try to complete transaction
                const newTransaction = miner.transaction(transactionData)

                // console.log( `newTransaction: `, newTransaction)
                const { src, dest, amount }= transactionData
                const { error, fee, seq, hash, balance }= newTransaction
                result.push({ error, hash, fee, seq, balance })
                if( error ){
                    console.log( `Sorry transaction declined: ${error}`)
                } else {
                    miner.broadcastPeers('/transactions/announce',[newTransaction])
                    console.log( ` .. broadcasting to others: `, newTransaction )
                }
            })
            // console.log( `[transaction] result:`, result )
            return { result }
            }))

        // get fee and seq #
        .post('/transactions/prepare', handleJSON(async (queries) => {
            let result = []
            queries.forEach( ({ src, amount })=> {
                // now try to complete transaction
                const fee = miner.transactionFee({ amount })
                const srcWallet = miner.ledger.getWallet( src )
                if( srcWallet.error ){
                    result.push( srcWallet )
                } else {
                    const seq = srcWallet.seq
                    if( seq.error )
                        result.push( seq )
                    else
                        result.push( { fee, seq, publicKey: srcWallet.publicKey })
                }
            })
            return { result }
            }))
                        
        .post('/node/wallet_sync', handleJSON(async (wallets) => {
            let result = []
            wallets.forEach( walletData => {
                const name = walletData.name
                const updateWallet = miner.ledger.updateWallet(name, walletData)
                result.push({ name, error: updateWallet.error })
            })
            console.log( `[wallet_sync] result:`, result )
            return { result }
            }))

        .any('/*', (res, req) => {
            /* Wildcards - make sure to catch them last */
            res.end( JSON.stringify({ error: `Invalid request: '${req.getUrl()}'` }) )
            })
            
        .listen(host, port, (token) => {
            if (token) {
                // port = uWS.us_socket_local_port(token)
                console.log(`Miner running on ${host}:${port}`)
            } else {
                console.log('Failed finding available port')
                process.exit(-1)
            }
        });
    }

    main().catch(err => {
        console.log(err)
    })
}
