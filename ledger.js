import Ledger from './lib/Ledger.js'
import { urlCall, sha256Hash, fixRounding, time } from './lib/helper.js'

// Terminal functionality - this only runs when the file is run directly from terminal (so it's dual-use)

function ledgerInfo(){
    console.log( `LEDGER options:`)
    console.log( `- node ledger.js list` )
    console.log( `- node ledger.js check {walletname}`)
    console.log( `- node ledger.js create {walletname} [miner-server]` )
    console.log( `- node ledger.js transaction {sender} {receiver} {amount} transfer [miner-server]` )
    console.log( `- node ledger.js transaction-verify {hash1}[,hash2,...] {miner-server}`)
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
    if( method !== 'list' && !name ) console.log( `Please re-run with a walletname, ex. node ledger.js create joesmith`)
    
    switch( method ){
        case 'list':
            console.log( `Existing wallets & balances:` )
            console.log( ledger.walletBalances() )
            break

        case 'check':
            const publicKey =  ledger.getPublicKey(name)
            if( publicKey.error ){
                console.log( publicKey.error )
                return
            }
            console.log( `publicKey = ${publicKey} ; checksum is ok, valid address.`)
            break

        case 'create':
            url = param2

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

        case 'transaction':
            const dest = param2
            const amount = Number(param3 || 0)
            const type = param4.length<3 ? 'transfer' : param4
            url = param5

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
            response = await urlCall({ hostname: url, path: '/transactions/prepare', body: [{ src, amount }] })
            if( response.error || !response.result ){
                console.log( `  x invalid transaction fee request, aborting:`, response )
                return
            }

            const { fee, seq }= response.result[0]

            // now we accept this fee and authorize/sign the transaction
            const signedTransaction = ledger.transactionSign({src, dest, amount, fee, type, seq: seq+1})
            if( signedTransaction.error ){
                console.log( `  x unable to create signed transaction`)
                return
            }

            // post the signed transaction
            console.log( ` - Queried for fee (fee=$${fee}) on $${signedTransaction.amount}; prepared (sequence=${seq+1}) & signed transaction (timestamp=${signedTransaction.timestamp}; txSig=${signedTransaction.txSig.substring(0,10)}...${signedTransaction.txSig.length})` )
            response = await urlCall({ hostname: url, path: '/transactions', body: [ signedTransaction ] })
            if( response.error ){
                console.log( `   x mining server $({url}) rejected it: ${response.error}`)
                return
            }
            const result = response.result[0]
            if( result.error )
                console.log( ` * mining server REJECTED transaction: ${result.error}` )
            else
                console.log( ` * mining server accepted. Transaction Hash: ${result.hash}, Balance: ${result.balance}` )
            break

        case 'transaction-verify': // merkle tree proof returned, thus proving the node has the transaction
            const hash = param1 // may be multiple hashes comma separated
            hostname = param2
            response = await urlCall({ hostname, path: `/transactions/verify?hash=${hash}` })
            if( response.error || !response.result ){
                console.log( `  x invalid hash - aborting:`, response )
                return
            }
            response.result.forEach( verify => {
                const result = ledger.merkleVerify(verify.hash, verify.proof, verify.merkleRoot)
                console.log( ` ... merkle proof PASSED for server with transaction (hash=${verify.hash}): in block (#${verify.block.index}) created on (${verify.block.timestamp})` )
            })
            break

        default:
            ledgerInfo()
            break
    }
}
main()