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
import { handleGET, handlePOST, time, debug } from './lib/helper.js'

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
import fs from 'fs'
import path from 'path'

// parameters passed in + defaults
const [ flags, minerName, morePeers ] = process.argv.slice(2)

const NAME = minerName || process.env.NAME          // name of this miner
const HOST = process.env.HOST                       // IP host to listen from
const PORT = process.env.PORT                       // IP port to listen to
const PEERS = process.env.PEERS                     // IPs of other trusted nodes
const MINER_DATA_PATH = process.env.MINER_DATA_PATH // where data is stored

const MINER_TYPE = process.env.MINER_TYPE
const MINER_WALLET = process.env.MINER_WALLET
const BLOCKCHAIN_PUBLICKEY = process.env.BLOCKCHAIN_PUBLICKEY

let peers = PEERS.split(',')
if( morePeers ) peers = peers.concat( morePeers.includes(',') ? morePeers.split(',') : [ morePeers ] )

async function server() {
    // start miner daemon
    const walletFile = path.join(MINER_DATA_PATH, NAME, MINER_WALLET)
    try { fs.mkdirSync(path.dirname(walletFile), { recursive: true }) } catch(e) { console.log(`path ${walletFile} exists already.`)}
    debugger
    const serverMiner = new Miner( NAME, MINER_TYPE, HOST, PORT, peers, MINER_DATA_PATH, walletFile )
    
    // now run webserver to engage with network
    uWS.App({ /* cert_file_name: cert, key_file_name: key */})
    .get('/blocks', handleGET((res, req) => {
        debug('dim', `>> [${req.authtoken}]${req.url}`)
        const fromIndex = Number(req.query.fromIndex || 0)
        const type = ['hashes','meta'].includes(req.query.type) ? req.query.type : ''
        const result = serverMiner.Blockchain.getChain(fromIndex, 100, type)
        res.end( JSON.stringify({ error: false, result }) )
        }, serverMiner.P2P.getNodeState()))
    
    .get('/node/wallets', handleGET((res, req) => {
        debug('dim', `>> [${req.authtoken}]${req.url}:`)
        const addresses = req.query.addresses === 'ALL' ? [] : req.query.addresses.split(',')
        const result = serverMiner.Wallet.balances(addresses)
        res.end( JSON.stringify({ error: false, result }) )
        }, serverMiner.P2P.getNodeState()))

    .get('/transactions/verify', handleGET((res, req) => {
        debug('dim', `>> [${req.authtoken}]${req.url}?${req.getQuery()}`)

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
        debug('dim', `>> [${req.authtoken}]${req.url}?${req.getQuery()}`)

        let result = serverMiner.Mempool.Queue.getMinerSorted({ miner: serverMiner.nodeName })
        res.end( JSON.stringify({ error: false, result }) )
        }, serverMiner.P2P.getNodeState()))

    .get('/transactions', handleGET((res, req) => {
        debug('dim', `>> [${req.authtoken}]${req.url}?${req.getQuery()}`)

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
        debug( 'dim', `>> [${head.authtoken}]${head.url} hostname(${info.hostname.replace('http://localhost:','')}) type(${info.type}) blockchainHeight(${info.blockchainHeight}) pendingTransactions(${info.pendingTransactionsCnt}) peers(${info.peers.join(',').replaceAll('http://localhost:','')})` )

        // include the post contactee, and add to our peer list
        info.peers.push( info.hostname ) 
        serverMiner.P2P.addPeers( info.peers )

        // they sent index/hash of their latest block, we'll send our hash for that block
        return { error: false, ...serverMiner.P2P.pingInfo(info.blockAtHeight.index) }
        }, serverMiner.P2P.getNodeState() ))

    .post('/block/announce', handlePOST(async (block,head) => {
        debug( 'cyan', `>> [${head.authtoken}]${head.url} #${block.index}` )

        serverMiner.P2P.setNodeState('ADD_BLOCK')
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
                serverMiner.P2P.setNodeState('ONLINE')
                return addResult
            }
        }
        serverMiner.P2P.setNodeState('ONLINE')

        // if we are mining same block, cancel our block (our miner will try again for next block)
        serverMiner.MinerWorker.stopMining()

        return addResult
        }, serverMiner.P2P.getNodeState() ))

    .post('/transaction/announce', handlePOST(async (transaction,head) => {
        let result = serverMiner.TransactionHandler.processTransaction( transaction )
        return { result }
        }, serverMiner.P2P.getNodeState()))

    // get fee and seq #
    .post('/transaction/prepare', handlePOST(async ({src, dest, amount, token, type = 'transfer', note = ''},head) => {
        debug(4,`>> [${head.authtoken}]${head.url}` )
        // now try to complete transaction
        const fee = serverMiner.TransactionHandler.getFee({ amount, token, type })
        const srcWallet = serverMiner.Wallet.getUserOrCreate( src )
        if( srcWallet.error ) return srcWallet
        
        const seq = srcWallet.seq.tx
        if( seq.error ) return seq
        
        const transaction = {src, dest, amount, token, fee, type, seq: seq+1, note }

        return { error: false, publicKey: srcWallet.publicKey, transaction }
        }, serverMiner.P2P.getNodeState()))

    .post('/transaction', handlePOST(async (transaction,head) => { // user initiated transaction to server
        // 
        if( !transaction.type || transaction.type !== 'transfer' )
            return { error: `Invalid type. Only transfer transactions allowed through this API.`}

        // came through us, stake minting right
        serverMiner.TransactionHandler.updateMeta([transaction],'miner',serverMiner.nodeName)
        const response = serverMiner.TransactionHandler.processTransaction(transaction)

        // debug only BUGUG
        const { src, dest, seq, amount, hash, meta }= transaction
        debug( 'cyan', `>> [${head.authtoken||'API'}]${head.url} (${serverMiner.Wallet.getNameOnly(src)}/${seq||'-'}) amount(${amount})  ${JSON.stringify(meta) || ''}`)

        // let result = []
        if( response.error ) return response

        // mempool transactions once accepted, are broadcast widely so others can get the balance+seq for that user
        serverMiner.P2P.broadcastTransaction( transaction )                
            
        // console.log( `[transaction] result:`, result )
        return { result: response }
        }, serverMiner.P2P.getNodeState()))
                    
    .post('/node/wallets', handlePOST(async (wallets,head) => {
        let result = []
        wallets.forEach( walletData => {
            const name = walletData.name
            const updateWallet = serverMiner.Wallet.updateWallet(name, walletData)
            result.push({ name, error: updateWallet.error })
        })
        debug( `>>${head.authtoken}${head.url} result:`, result )
        return { result }
        }, serverMiner.P2P.getNodeState()))

    // get fee and auth infoseq #
    .post('/token/auth', handlePOST(async ({action,token,amount,admin,dest},head) => {
        console.log( `[token/auth] action(${action}) amount(${amount}) token(${token}) admin(${admin})`)
        let result = []
        // current logic: only single owner/'admin' - we pass back the transaction for the client to sign     
        const fee = serverMiner.TransactionHandler.getFee({ amount, token, type: action })

        if( action === 'tokenCreate' ){
            admin = serverMiner.Wallet.buildNameWithPublicKey(admin)

            // generate the transactions that the token-creater has to authorize (and pay for, the 'fee')
            const transactions = serverMiner.TransactionHandler.tokenCreation(amount, token, admin)
            if( transactions.error ) return transactions
            result = { action, token, amount, fee, admin, transactions }

        } else if( action === 'tokenAirdrop' ){
            // check if authorized to airdrop, and return the signing authority (admin) for the token
            const adminWallet = serverMiner.Wallet.getUser(token)
                
            if( adminWallet.error )
                return { error: `Token ecosystem ${token} does not exist on node. Rejecting.`}
            else if( !adminWallet.admin )
                return { error: `Unable to airdrop to ${token} as no 'admin' to signoff on airdrop. Rejecting request.` }

            admin = token !== serverMiner.TransactionHandler.BASE_TOKEN ? adminWallet.admin : '*root:' + BLOCKCHAIN_PUBLICKEY

            const seq = adminWallet.seq.tx + 1

            
            const transactions = [
                { src: token, dest, amount, token, fee, type: 'tokenAirdrop', timestamp: time(), seq }
                ]
            result = { action, token, amount, fee, admin, transactions }
        }

        // debug( `>>${head.authtoken}${head.url} result:`, JSON.stringify(result) )
        return { result }
        }, serverMiner.P2P.getNodeState()))
        // response = await urlCall({ hostname: url, path: '/token/auth', body: [{ token, amount, admin }] })
                    
    .post('/token/transactions', handlePOST(async ({token,amount,admin,transactions},head) => {
        let result = []
        for( let transaction of transactions )
            if( transaction.error ) return transaction

        console.log( ` /token/transactions: token(${token}) amount(${amount}) admin(${admin}) transactions:`,transactions)
        // tag them to be processed on our node
        serverMiner.TransactionHandler.updateMeta(transactions,'miner',serverMiner.nodeName)
debugger
        // let's run this transaction
        const response = serverMiner.TransactionHandler.processTransactions(transactions)
        console.log( ` resonse: `, response )
        if( response.error ){
            debug( 1, `<red>ERROR:</> Unable to process token: ${response.error}` )
            return
        }

        // share it so mempool transaction known before block mined
        for( const transaction of transactions )
            serverMiner.P2P.broadcastTransaction( transaction )    
        
        debug( `>>${head.authtoken}${head.url} result:`, response )
        // return { response}
        return { result: response }

        }, serverMiner.P2P.getNodeState()))

    .any('/*', (res, req) => {
        /* Wildcards - make sure to catch them last */
        res.end( JSON.stringify({ error: `Invalid request: '${req.getUrl()}'` }) )
        })
        
    .listen(HOST, PORT, (ws_token) => {
        if (ws_token) {
            // port = uWS.us_socket_local_port(ws_token)
            debug('green', `Miner running on ${HOST}:${PORT}; Miner discovering peers`)
        } else {
            debug('red', 'Failed finding available port')
            process.exit(-1)
        }
    })
}

    // process.on('unhandledRejection', (reason, promise) => {
    //     console.error('Unhandled Rejection at:', promise, 'reason:', reason.stack || reason);
    //   });
try { 
    server()
} catch( e ){
    debug( `error: ${e.message}` )
    console.log( e.data )
}
    // .catch(err => {
    //     debug('red',err)
    // })