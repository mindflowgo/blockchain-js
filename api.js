import Miner from './lib/Miner.js'
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
    Wallet.load()

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
            let addresses = param1 === 'ALL' ? 'ALL' : param1.split(',').map( n=>Wallet.buildNameWithPublicKey(n) ).join(',') // may be multiple hashes comma separated
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
                wallets = Wallet.balances()
            }

            // arrange alphabettically and display
            debug('dim',`   = Name =${' '.repeat(14)} = Unconfirmed =${' '.repeat(6)} = On-Chain Balance =  = Depth =   = Notes =`)
            wallets.filter( w => w.name ).sort((a, b) =>  a.name.localeCompare(b.name)).forEach( i=>{
                const name = i.name.length>19 ? i.name.substring(0,17)+'...' : i.name 
                if( !(name.length===0 && name === '_') && i.$.tx.balance>0 ){
                    let seqInfo = i.$.tx?.seq > 0 || i.$.onChain?.seq > 0 ? `${i.$.tx.seq},${i.$.onChain.seq}` : ''
                    seqInfo = !seqInfo ? ':' : '/' + seqInfo + ':'
                    debug('dim',`   - ${name}${seqInfo}${' '.repeat(20-(seqInfo.length+name.length))} $ ${i.$.tx.balance || '0'} `
                              + `${' '.repeat(18-i.$.tx.balance.toString().length)} ${i.$.tx.balance === i.$.onChain.balance ? '  "' : `$ `+i.$.onChain.balance} `
                              + `${' '.repeat(25-(i.$.tx.balance === i.$.onChain.balance ? '  "' : `$ `+i.$.onChain.balance).toString().length)}`
                              + `${' '.repeat(4-i.depth.toString().length)}${i.depth}`
                              + `      ${i.note || ''}`
                            )
                }
                })
            break
            }
        case 'check': {
            const publicKey =  Wallet.getUserPublicKey(name)
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
            const wallet = name.indexOf(':') === -1 ? Wallet.generate(name) : Wallet.getUser(name)
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

        // node wallet.js transaction {sender} {receiver} {token} {amount} transfer [miner-server-api-url]` )
        case 'transaction': {
            const dest = param2
            const token = param3
            const amount = Number(param4 || 0)
            const type = param5.length<3 ? 'transfer' : param5
            const url = param6
            const note = param7 || ''
console.log( `[transaction] dest(${dest}) token(${token}) amount(${amount}) type(${type}) url(${url})`)
            if( !['escrow','transfer'].includes(type) ){
                debug( 'red', `Invalid type of transaction. Use: 'transfer' or 'escrow'`)
                return
            }
            // console.log( ` amount(${amount}) type(${type}) url(${url})`)
            if( !dest || amount <= 0 || !url ){
                debug( 'red', `A valid dest (${dest}) and positive amount (${amount}) is needed, type(${type}), server (${url}) too; try again.` )
                return
            }

            // let's get the fee for transaction & seq
            const src = Wallet.buildNameWithPublicKey(name)
            if( src.error ){
                debug( 'red', src.error )
                return
            }
            response = await urlCall({ hostname: url, path: '/transactions/prepare', body: [{ src, amount, token }] })
            if( response.error || !response.result ){
                debug( 'red', `  x invalid transaction prepare request, aborting:`, response )
                return
            }

console.log( ` ../transactios/prepare result: `, response )
            // now we accept this fee and authorize/sign the transaction (with users last seq #)
            const { fee, seq }= response.result[0]
            if( note.length>0 && note.startsWith('*') ){ // encrypt note for recipient only
                const srcWallet = Wallet.getUser(src)
                note = '*' + Wallet.sign(srcWallet.privateKey, note)
                debug('dim',`! encrypted note: ${note}`)
            }
            console.log( `src(${src}) dest(${dest}) amount(${amount}) fee (${fee}) seq(${seq})`)
            const transactionData = {src, dest, amount, token, fee, type, seq: seq+1, note }
            const transaction = TransactionHandler.prepareTransaction(transactionData)
            const balanceCheck = TransactionHandler.checkTokenBalances(transaction,{ blockIdx })
            if( !transaction.error && !balanceCheck.error )
    console.log( `transaction: `, transaction )
            if( transaction.error ){
                console.log( `  ! Signing error:`, transaction.error )
                return
            }

            // post the signed transaction
            debug( 'dim', ` - Queried server for fee/seq: [${src.split(':')[0]}/${seq+1} -> ${dest.split(':')[0]} ${token}${transaction.amount}] / ${type} + fee=$${fee}; signing & posting...` )
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
            const dest = Wallet.buildNameWithPublicKey(param2)
            const amount = Number(param3 || 0)
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
                    const result = TransactionHandler.merkleVerify(verify.hash, verify.proof, verify.merkleRoot)
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
                debug('green',`Block#${meta.blockIdx} / ${hash.substring(0,10)} :  Transaction ${src.split(':')[0]}/${seq} -> ${dest.split(':')[0]}  $${amount} (fee: $${fee})` )
                if( note.startsWith('*') ){
                    const srcWallet = Wallet.getUser(src)
                    const signedNote = note.slice(1) // remove leading *
                    const textNote = Wallet.decode(srcWallet.publicKey, signedNote).slice(1)
                    debug('cyan',`                         ~ private (only viewable by ${dest.split(':')[0]}) note: "${textNote}"`)
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