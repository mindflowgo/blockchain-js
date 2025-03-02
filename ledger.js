import Ledger from './lib/Ledger.js'
import { urlCall, sha256Hash, fixRounding, time, debug } from './lib/helper.js'

// Terminal functionality - this only runs when the file is run directly from terminal (so it's dual-use)

function ledgerInfo(){
    console.log( `LEDGER options:`)
    console.log( `- node ledger.js wallets {wallet1}[,wallet2,...] [miner-server-api-url]` )
    console.log( `- node ledger.js check {walletname}`)
    console.log( `- node ledger.js create {walletname} [miner-server-api-url]` )
    console.log( `- node ledger.js miner-deposit {miner-name} {receiver} {amount} {miner-server-api-url}` )
    console.log( `- node ledger.js transaction {sender} {receiver} {amount} transfer {miner-server-api-url}` )
    console.log( `- node ledger.js transaction-verify {hash1}[,hash2,...] {miner-server-api-url}`)
}

if( process.argv.length<3 ){
    ledgerInfo()
    process.exit()
}

async function main(){
    let response = false
    let hostname = 'http://localhost:5000'
    let url = ''
    // default path for the user wallet
    const ledger = new Ledger('./data/wallet.json')
    const method = process.argv[2]
    const param1 = process.argv[3] || ''
    const name = param1
    const param2 = process.argv[4] || ''
    const param3 = process.argv[5] || ''
    const param4 = process.argv[6] || ''
    const param5 = process.argv[7] || ''
    if( method !== 'wallets' && !name ) console.log( `Please re-run with a walletname, ex. node ledger.js create joesmith`)
    
    switch( method ){
        case 'wallets': {
            let walletNames = param1 === 'ALL' ? 'ALL' : param1.split(',').map( n=>ledger.buildTransactionName(n) ).join(',') // may be multiple hashes comma separated
            const url = param2.split(',') || [ param2 ]

            let wallets = []
            if( walletNames.length<1 ){
                console.log( `Please include some wallets to get information for! Ex. node ledger.js wallets fil:publickey,fred:publickey http://localhost:5000`)
                return
            }

            // console.log( ledger.walletBalances() )

            if( url[0].length > 0 ){
                console.log( `\nExisting wallets & balances on servers (${url.join(',')}):` )
                for (let [idx, host] of url.entries()) {
                    const response = await urlCall({ hostname: host, path: `/node/wallets?wallets=${walletNames}` })
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
                wallets = ledger.walletBalances()
            }

            // arrange alphabettically and display
            debug('dim',`   = Name =${' '.repeat(15)} = TX Balance =${' '.repeat(4)} = Block Balance =`)
            wallets.filter( w => w.name ).sort((a, b) =>  a.name.localeCompare(b.name)).forEach( i=>{
                const name = i.name.length>19 ? i.name.substring(0,17)+'...' : i.name 
                if( !(name.length===0 && name === '_') && i.tx.balance>0 ){
                    let seqInfo = i.tx?.seq > 0 || i.onChain?.seq > 0 ? `${i.tx.seq},${i.onChain.seq}` : ''
                    seqInfo = !seqInfo ? ':     ' : '/' + seqInfo + ':' //  + ' '.repeat(12 - seqInfo.length)
                    debug('dim',`   - ${name}${seqInfo}${' '.repeat(15-name.length)} $ ${i.tx.balance || '0'} ${' '.repeat(15-i.tx.balance.toString().length)} $ ${i.onChain.balance || '0'} ${' '.repeat(20-i.tx.balance.toString().length)} ${i.note || ''}`)
                }
                })
            break
            }
        case 'check': {
            const publicKey =  ledger.getPublicKey(name)
            if( publicKey.error ){
                console.log( publicKey.error )
                return
            }
            console.log( `publicKey = ${publicKey} ; checksum is ok, valid address.`)
            break
            }
        case 'create': {
            const url = param2

            const newWallet = ledger.createWallet(name)
            if( newWallet.error ) return newWallet
            
            console.log( `   > Created! publicKey(${newWallet.publicKey})` )

            if( !url || url.length<10 ) return

            console.log( `- pushing to url(${url})`)
            // broadcast to a miner: don't share privateKey (obviously)!
            let walletData = newWallet
            delete walletData.privateKey
            delete walletData.balance
            response = await urlCall({ hostname: url, path: '/wallet_sync', body: [ walletData ] })
            if( response.error ) return response

            console.log(`- synced to server:` )
            response.result.forEach( item=>{
                if( Object.values(item) == 'ok' )
                    console.log( ` * ${Object.keys(item)} confirmed sync'd` )
            } )
            break
            }

        // node ledger.js transaction {sender} {receiver} {amount} transfer [miner-server-api-url]` )
        case 'transaction': {
            const dest = param2
            const amount = Number(param3 || 0)
            const type = param4.length<3 ? 'transfer' : param4
            const url = param5

            if( !['escrow','transfer'].includes(type) ){
                console.log( `Invalid type of transaction. Use: 'transfer' or 'escrow'`)
                return
            }
            // console.log( ` amount(${amount}) type(${type}) url(${url})`)
            if( !dest || amount <= 0 || !url ){
                console.log( `A valid dest (${dest}) and positive amount (${amount}) is needed, type(${type}), server (${url}) too; try again.` )
                return
            }

            // let's get the fee for transaction & seq
            const src = ledger.buildTransactionName(name)
            if( src.error ){
                console.log( src.error )
                return
            }
            response = await urlCall({ hostname: url, path: '/transactions/prepare', body: [{ src, amount }] })
            if( response.error || !response.result ){
                console.log( `  x invalid transaction prepare request, aborting:`, response )
                return
            }


            // now we accept this fee and authorize/sign the transaction (with users last seq #)
            const { fee, seq }= response.result[0]
            const signedTransaction = ledger.transactionSign({src, dest, amount, fee, type, seq: seq+1})
            if( signedTransaction.error ){
                console.log( `  x unable to create signed transaction`)
                return
            }

            // post the signed transaction
            console.log( ` - Queried for fee (fee=$${fee}) on $${signedTransaction.amount}; prepared (sequence=${seq+1}) & signed transaction (timestamp=${signedTransaction.timestamp}; txSig=${signedTransaction.txSig.substring(0,10)}...${signedTransaction.txSig.length})` )
            response = await urlCall({ hostname: url, path: '/transactions', body: [ signedTransaction ] })
            if( response.error ){
                console.log( `   x mining server (${url}) rejected it: ${response.error}`)
                return
            }
            const result = response.result[0]
            if( result.error )
                console.log( ` * mining server REJECTED transaction: ${result.error}` )
            else
                console.log( ` * mining server accepted. Seq: ${result.seq}, Fee: $${result.fee}, Transaction Hash: ${result.hash}, Balance: ${result.balance}` )
            break
            }

        // node ledger.js deposit {miner-name} {receiver} {amount} [miner-server-api-url]` )
        case 'miner-deposit': {
            const src = name
            const dest = ledger.buildTransactionName(param2)
            const amount = Number(param3 || 0)
            const url = param4

            if( dest.error ){
                debug('red',dest.error)
                return
            }
            // const src = ledger.buildTransactionName(name)
            // if( src.error ){
            //     console.log( ` * rejected: ${src.error}`)
            //     return
            // }

            // let's get the fee for transaction & seq
            response = await urlCall({ hostname: url, path: '/transactions/prepare', body: [{ src, amount }] })
            if( response.error || !response.result ){
                console.log( `  x invalid transaction prepare request, aborting:`, response )
                return
            }
            // now we accept this fee and authorize/sign the transaction (with users last seq #)
            const { fee, seq }= response.result[0]

            const minerTransaction = {src, dest, amount, fee, type: 'minerDeposit', seq: seq+1}
            response = await urlCall({ hostname: url, path: '/transactions', body: [ minerTransaction ] })
            if( response.error ){
                console.log( `   x mining server (${url}) rejected it: ${response.error}`)
                return
            }
            const result = response.result[0]
            if( result.error )
                console.log( ` * mining server REJECTED transaction: ${result.error}` )
            else
                console.log( ` * mining server accepted. Seq: ${seq}, Fee: $${fee}, Transaction Hash: ${result.hash}, Balance: ${result.balance}` )
            break
            }

        case 'transaction-verify': // merkle tree proof returned, thus proving the node has the transaction
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
                    const result = ledger.merkleVerify(verify.hash, verify.proof, verify.merkleRoot)
                    console.log( `${verify.hash}: VALID -- merkle proof PASSED for server, found in block (#${verify.block.index}) created on (${verify.block.timestamp})` )
                }
            })
            break

        default:
            ledgerInfo()
            break
    }
}
main()