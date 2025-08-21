import Wallet from './lib/Wallet.js'
import TransactionHandler from './lib/TransactionHandler.js'

import { urlCall, fixRounding, time, debug } from './lib/helper.js'

// Terminal functionality - this only runs when the file is run directly from terminal (so it's dual-use)

function walletInfo(){
    console.log( `wallet options:`)
    console.log( `- node api.js addresses {wallet1}[,wallet2,...] [miner-server-api-url]` )
    console.log( `- node api.js check {walletname}`)
    console.log( `- node api.js create {walletname} [miner-server-api-url]` )
    console.log( `- node api.js miner-deposit {miner-name} {receiver} {amount} {miner-server-api-url}` )
    console.log( `- node api.js transaction {sender} {receiver} {amount} transfer {miner-server-api-url} [*][note]` ) // can attach a note to transaction
    console.log( `- node api.js transaction-verify {hash1}[,hash2,...] {miner-server-api-url}`)
    console.log( `- node api.js examine {hash} {miner-server-api-url}` )
    
}

if( process.argv.length<3 ){
    walletInfo()
    process.exit()
}

async function main(){
    // Miner.dataPath
    const userTransactionHandler = new TransactionHandler()
    const userWallet = new Wallet(undefined, userTransactionHandler)
    userTransactionHandler.setHelperClasses(userWallet)

    let response = false
    let hostname = 'http://localhost:5000'
    let url = ''
    // default path for the user wallet
    const method = process.argv[2]
    const param1 = process.argv[3] || ''
    const name = param1
    const param2 = process.argv[4] || ''
    const param3 = process.argv[5] || ''
    const param4 = process.argv[6] || ''
    const param5 = process.argv[7] || ''
    const param6 = process.argv[8] || ''
    const param7 = process.argv[9] || ''
    if( method !== 'addresses' && !name ) console.log( `Please re-run with a walletname, ex. node wallet.js create joesmith`)
    
    switch( method ){
        case 'wallets': {
            let addresses = param1 === 'ALL' ? 'ALL' : param1.split(',').map( n=>userWallet.buildNameWithPublicKey(n) ).join(',') // may be multiple hashes comma separated
            const url = param2.split(',') || [ param2 ]

            let wallets = []
            if( addresses.length<1 ){
                console.log( `Please include some wallets to get information for! Ex. node wallet.js wallets fil:publickey,fred:publickey http://localhost:5000`)
                return
            }

            // console.log( wallet.walletBalances() )

            if( url[0].length > 0 ){
                console.log( `\nExisting wallets & balances on servers (${url.join(',')}):` )
                for (let [idx, host] of url.entries()) {
                    const response = await urlCall({ hostname: host, path: `/node/wallets?addresses=${addresses}` })
                    if( response.error ){
                        console.log( response.error )
                        return
                    }
                    if( idx===0 ){
                        wallets = response.result
                        for( let i=0; i<wallets.length; i++ ) wallets[i].note = ''
                    } else {
                        response.result.forEach((wallet) => {
                            const wIdx = wallets.findIndex(w => w.publicKey === wallet.publicKey)
                            if (wIdx !== -1) {
                                if (wallets[wIdx].tx.balance !== wallet.tx.balance) {
                                    wallets[wIdx].note += `${idx}: $${fixRounding(wallets[wIdx].tx.balance - wallet.tx.balance)} `
                                }
                                if (wallets[wIdx].onChain.balance !== wallet.onChain.balance) {
                                    wallets[wIdx].note += `${idx}: $${fixRounding(wallets[wIdx].onChain.balance - wallet.onChain.balance)} `
                                }
                                if (wallets[wIdx].tx?.seq !== wallet.tx?.seq) {
                                    wallets[wIdx].note += `${idx}: Seq(${wallets[wIdx].tx?.seq||'-'}|${wallet.tx?.seq||'-'}) `
                                }
                            } else {
                                // If the wallet is not in the list, add it
                                wallets.push({ ...wallet, note: '' })
                            }
                        })
                    }
                }
            } else {
                console.log( `\nExisting wallets & balances on local:` )
                wallets = userWallet.balances()
            }

            // arrange alphabettically and display
            debug('dim',`   = Name =${' '.repeat(14)} = Unconfirmed =${' '.repeat(6)} = On-Chain Balance =  = Depth =   = Notes =`)
            console.log( 'wallets:', wallets )
            const BASE_TOKEN = userTransactionHandler.BASE_TOKEN
            wallets.filter( w => w.name ).sort((a, b) =>  a.name.localeCompare(b.name)).forEach( i=>{
                const name = i.name.length>19 ? i.name.substring(0,17)+'...' : i.name 
                // find wallet with this name, and cycle through the tokens
                // for( const token of this.listTokens(w) ){for( const token of this.listTokens(w) ){
                if( !(name.length===0 && name === userTransactionHandler.MINT_TOKEN) && i[BASE_TOKEN].tx.balance>0 ){
                    let seqInfo = i[BASE_TOKEN].tx?.seq > 0 || i[BASE_TOKEN].onChain?.seq > 0 ? `${i[BASE_TOKEN].seq.tx},${i[BASE_TOKEN].seq.onChain}` : ''
                    seqInfo = !seqInfo ? ':' : '/' + seqInfo + ':'
                    debug('dim',`   - ${name}${seqInfo}${' '.repeat(20-(seqInfo.length+name.length))} $ ${i[BASE_TOKEN].tx.balance || '0'} `
                              + `${' '.repeat(18-i[BASE_TOKEN].tx.balance.toString().length)} ${i[BASE_TOKEN].tx.balance === i[BASE_TOKEN].onChain.balance ? '  "' : `$ `+i[BASE_TOKEN].onChain.balance} `
                              + `${' '.repeat(25-(i[BASE_TOKEN].tx.balance === i[BASE_TOKEN].onChain.balance ? '  "' : `$ `+i[BASE_TOKEN].onChain.balance).toString().length)}`
                              + `${' '.repeat(4-i.depth.toString().length)}${i.depth}`
                              + `      ${i.note || ''}`
                            )
                }
                })
            break
            }
        case 'check': {
            const publicKey =  userWallet.getUserPublicKey(name)
            if( publicKey.error ){
                console.log( publicKey.error )
                return
            }
            console.log( `publicKey = ${publicKey} ; checksum is ok, valid address.`)
            break
            }
        case 'create': {
            const url = param2

            // we assume a ':' in name means they are just adding an address with public key in it
            const wallet = name.indexOf(':') === -1 ? userWallet.generate(name) : userWallet.getUser(name)
            if( wallet.error ){
                debug('red', wallet.error)
                break
            }
            
            console.log( `\n> ${name.indexOf(':') === -1 ? 'Created' : 'Added'}! *${wallet.name}* with publicKey(${wallet.publicKey})` )

            if( !url || url.length<10 ) return

            console.log( `- pushing to url(${url})`)
            // broadcast to a miner: don't share privateKey (obviously)!
            delete wallet.privateKey
            response = await urlCall({ hostname: url, path: '/wallet_sync', body: [ wallet ] })
            if( response.error ) return response

            console.log(`- synced to server:` )
            response.result.forEach( item=>{
                if( Object.values(item) == 'ok' )
                    console.log( ` * ${Object.keys(item)} confirmed sync'd` )
            } )
            break
            }
        case 'token-create': {
            const token = param2
            const amount = param3
            const tokenAdmin = param4
            const url = param5

            console.log( `Creating a token ( ${token} ) with circulation of ${amount}...` )
            if( !url || url.length<10 ) return

            const srcName = Wallet.getUser(tokenAdmin)
            response = await urlCall({ hostname: url, path: '/token/auth', body: [{ token, amount, tokenAdmin }] })
            if( response.error ) return response

            console.log(`- synced to server:` )
            response.result.forEach( item=>{
                if( Object.values(item) == 'ok' )
                    console.log( ` * ${Object.keys(item)} confirmed sync'd` )
            } )
            break

        }

        // node wallet.js transaction {sender} {receiver} {token?}{amount} transfer [miner-server-api-url]` )
        case 'transaction': {
            let dest = param2
            let amount = param3
            const type = param4.length<3 ? 'transfer' : param4
            const url = param5
            const note = param6 || ''
            let token
            { [amount, token] = userTransactionHandler.extractTokenFromAmount( amount, token ) }
console.log( `[transaction] dest(${dest}) amount(${amount}) type(${type}) url(${url})`)
            if( !['escrow','transfer'].includes(type) ){
                debug( 'red', `Invalid type of transaction. Use: 'transfer' or 'escrow'`)
                return
            }
            dest = userWallet.buildNameWithPublicKey(dest)
            if( dest.error || !dest || !url ){
                debug( 'red', dest.error )
                return
            }

            // let's get the fee for transaction & seq
            const src = userWallet.buildNameWithPublicKey(name)
            if( src.error ){
                debug( 'red', src.error )
                return
            }
            response = await urlCall({ hostname: url, path: '/transactions/prepare', body: [{ src, amount }] })
            if( response.error || !response.result ){
                debug( 'red', `  x invalid transaction prepare request, aborting:`, response )
                return
            }

console.log( ` ../transactios/prepare result: `, response )
            // now we accept this fee and authorize/sign the transaction (with users last seq #)
            const { fee, seq }= response.result[0]
            if( note.length>0 && note.startsWith('*') ){ // encrypt note for recipient only
                const srcWallet = userWallet.getUser(src)
                note = '*' + userWallet.sign(srcWallet.privateKey, note)
                debug('dim',`! encrypted note: ${note}`)
            }
            console.log( `src(${src}) dest(${dest}) amount(${amount}) fee (${fee}) seq(${seq})`)
            const transactionData = {src, dest, amount, token, fee, type, seq: seq+1, note }
            const transaction = userTransactionHandler.transactionSign(transactionData)
            console.log( `transaction: `, transaction )
            // if( !transaction.error )
            if( transaction.error ){
                console.log( `  ! Signing error:`, transaction.error )
                return
            }

            // post the signed transaction
            debug( 'dim', ` - Queried server for fee/seq: [${userWallet.getNameOnly(src)}/${seq+1} -> ${userWallet.getNameOnly(dest)} ${transaction.token}${transaction.amount}] / ${type} + fee=$${fee}; signing & posting...` )
            response = await urlCall({ hostname: url, path: '/transactions', body: [ transaction ] })
            if( response.error ){
                debug( 'red', `   x mining server (${url}) rejected it: ${response.error}`)
                return
            }
            const result = response.result[0]
            if( result.error ){
                debug( 'red', `   x mining server REJECTED transaction: ${result.error}` )
            } else {
                if( result.meta.warning ) debug('cyan', `   ! Warning: Accepted but increased risk of failure because: ${result.meta.warning}` )

                debug( 'green', `   \ mining server accepted - transaction hash: ${result.hash}, expected balance: $${result.meta.balance}` ) // Seq: ${result.seq}, Fee: $${result.fee},
            }
            debug( 'dim', ` `)
            break
            }

        // node wallet.js deposit {miner-name} {receiver} {amount} [miner-server-api-url]` )
        case 'miner-deposit': {
            const src = name
            const dest = userWallet.buildNameWithPublicKey(param2)
            const amount = param3
            const url = param4

            if( dest.error ){
                debug('red',dest.error)
                return
            }
            // const src = wallet.buildNameWithPublicKey(name)
            // if( src.error ){
            //     console.log( ` * rejected: ${src.error}`)
            //     return
            // }

            // let's get the fee for transaction & seq
            response = await urlCall({ hostname: url, path: '/transactions/prepare', body: [{ src, amount }] })
            if( response.error || !response.result ){
                debug( 'red', `  x invalid transaction prepare request, aborting:`, response )
                return
            }
            // now we accept this fee and authorize/sign the transaction (with users last seq #)
            const { fee, seq }= response.result[0]

            const minerTransaction = {src, dest, amount, fee, type: 'minerDeposit', seq: seq+1}
            response = await urlCall({ hostname: url, path: '/transactions', body: [ minerTransaction ] })
            if( response.error ){
                debug( 'red', `   x mining server (${url}) rejected it: ${response.error}`)
                return
            }
            const result = response.result[0]
            if( result.error )
                debug( 'red', ` * mining server REJECTED transaction: ${result.error}` )
            else
                debug( 'green', ` * mining server accepted. Seq: ${seq}, Fee: $${fee}, Transaction Hash: ${result.hash}, Balance: $${result.meta.balance}` )
            break
            }

        case 'transaction-verify': {// merkle tree proof returned, thus proving the node has the transaction
            const hash = param1 // may be multiple hashes comma separated
            hostname = param2
            response = await urlCall({ hostname, path: `/transactions/verify?hash=${hash}` })
            if( response.error || !response.result ){
                console.log( `  x invalid hash - aborting:`, response )
                return
            }
            response.result.forEach( verify => {
                if( verify.error ){
                    console.log( `${verify.hash}: No available block; it's invalid.`)
                } else {
                    const result = userTransactionHandler.merkleVerify(verify.hash, verify.proof, verify.merkleRoot)
                    console.log( `${verify.hash}: VALID -- merkle proof PASSED for server, found in block (#${verify.block.index}) created on (${verify.block.timestamp})` )
                }
            })
            break
            }

        case 'examine': {// merkle tree proof returned, thus proving the node has the transaction
            const hash = param1 // may be multiple hashes comma separated
            hostname = param2
            response = await urlCall({ hostname, path: `/transactions?hash=${hash}` })
            if( response.error || !response.result ){
                console.log( `  x invalid hash - aborting:`, response )
                return
            }
            
            for( const transaction of response.result ){
                const {src, dest, amount, fee, seq, hash, note, meta, ...data} = transaction   
                debug('green',`Block#${meta.blockIdx} / ${hash.substring(0,10)} :  Transaction ${userWallet.getNameOnly(src)}/${seq} -> ${userWallet.getNameOnly(dest)}  $${amount} (fee: $${fee})` )
                if( note.startsWith('*') ){
                    const srcWallet = userWallet.getUser(src)
                    const signedNote = note.slice(1) // remove leading *
                    const textNote = userWallet.decode(srcWallet.publicKey, signedNote).slice(1)
                    debug('cyan',`                         ~ private (only viewable by ${userWallet.getNameOnly(dest)}) note: "${textNote}"`)
                } else if( note ){
                    debug('cyan',`                         ~ public note: ${note}`)
                }
            }
            // console.log( `- node wallet.js transaction-examine {hash} {miner-server-api-url}` )
            break
            }
        default:
            walletInfo()
            break
    }
}
main()