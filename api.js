import Crypto from './lib/Crypto.js'
import Wallet from './lib/Wallet.js'
import TransactionHandler from './lib/TransactionHandler.js'

import { urlCall, fixRounding, time, debug, formatURL } from './lib/helper.js'

// from .env
const BLOCKCHAIN_PRIVATEKEY = process.env.BLOCKCHAIN_PRIVATEKEY
const USER_WALLET = process.env.USER_WALLET

function walletInfo(){
    debug( `wallet options:`)
    debug( `- ./api.sh addresses {wallet1}[,wallet2,...] [miner-server-api-url]` )
    debug( `- ./api.sh check {walletname}`)
    debug( `- ./api.sh create {walletname} [miner-server-api-url]` )
    debug( `- ./api.sh miner-deposit {miner-name} {receiver} {amount} {miner-server-api-url}` )
    debug( `- ./api.sh send {sender} {receiver} {amount} {miner-server-api-url} [*][note]` ) // can attach a note to transaction
    debug( `- ./api.sh transaction-verify {hash1}[,hash2,...] {miner-server-api-url}`)
    debug( `- ./api.sh examine {hash} {miner-server-api-url}` )
    debug( `- ./api.sh token-create {token} {+/- amount} {admin-user} {miner-server-api-url}` )
    debug( `- ./api.sh token-supply {token} {+/- amount} [{auth-signing}] {miner-server-api-url}` )
    debug( `- ./api.sh token-airdrop {token}{amount} {walletname} {miner-server-api-url}` )
}

if( process.argv.length<3 || !USER_WALLET ){
    walletInfo()
    process.exit()
}

async function commandLineProcess(){
    const userTransactionHandler = new TransactionHandler()
    const userWallet = new Wallet(USER_WALLET, userTransactionHandler)
    userTransactionHandler.setHelperClasses(userWallet)

    let response = false
    let miner_url = formatURL('localhost:5000')
    let token = userTransactionHandler.BASE_TOKEN
    // default path for the user wallet
    const [ method, param1, param2, param3, param4, param5, param6, param7 ] = process.argv.slice(2)
    const name = param1
    if( method !== 'addresses' && !name ) console.log( `Please re-run with a walletname, ex. api.sh create joesmith`)
    
    switch( method ){
        case 'wallets': {
            let addresses = param1 === 'ALL' ? 'ALL' : param1.split(',').map( n=>userWallet.buildNameWithPublicKey(n) ).join(',') // may be multiple hashes comma separated
            const miner_url = param2.split(',') || [ param2 ]

            let wallets = []
            if( addresses.length<1 ){
                console.log( `Please include some wallets to get information for! Ex. node wallet.js wallets fil:publickey,fred:publickey localhost:5000`)
                return
            }

            // console.log( wallet.walletBalances() )

            if( miner_url[0].length > 0 ){
                console.log( `\nExisting wallets & balances on servers (${miner_url.join(',')}):` )
                for (let [idx, host] of miner_url.entries()) {
                    const response = await urlCall({ url: formatURL(host) + 'node/wallets?addresses=' + addresses })
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
            debug( 1,`   = Name =${' '.repeat(14)} = Unconfirmed =${' '.repeat(6)} = On-Chain Balance =  = Depth =   = Notes =`)
            const BASE_TOKEN = userTransactionHandler.BASE_TOKEN
            const showWallets = wallets.filter( w => w.name ).sort((a, b) => (b.name.includes('$') - a.name.includes('$')) || a.name.localeCompare(b.name))
            for( const w of showWallets ){
                const name = w.name.length > 19 ? w.name.substring(0, 17) + '...' : w.name
                if( name === userTransactionHandler.MINT_TOKEN ) continue
                  // Tokens to show
                  const tokens = w.name.includes('$')
                    ? [w.name] // if wallet name is a token (like cad$, usd$)
                    : Object.keys(w).filter(k => k.includes('$')); // otherwise, all $-keys
              
                  for (const token of tokens) {
                    const txBal = w[token]?.tx?.balance || 0;
                    const onChainBal = w[token]?.onChain?.balance ?? txBal;
              
                    if (!(name.length === 0 && name === userTransactionHandler.MINT_TOKEN)) {
                      // format seq info
                      let seqInfo = w.seq?.tx > 0 || w.seq?.onChain > 0 ? `${w.seq.tx},${w.seq.onChain}` : '';
                      seqInfo = !seqInfo ? ':' : '/' + seqInfo + ':';
              
                      debug(
                        1,
                        `   - ${name} [${token}]${seqInfo}${' '.repeat(
                          20 - (seqInfo.length + name.length + token.length + 3)
                        )} $ ${txBal} ` +
                          `${' '.repeat(18 - txBal.toString().length)} ${
                            txBal === onChainBal ? '  "' : `$ ` + onChainBal
                          } ` +
                          `${' '.repeat(
                            25 -
                              (txBal === onChainBal ? '  "' : `$ ` + onChainBal).toString()
                                .length
                          )}` +
                          `${' '.repeat(4 - w.depth.toString().length)}${w.depth}` +
                          `      ${w.note || ''}`
                      );
                    }
                  }
                }
              
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
            if( param2 ) miner_url = formatURL(param2)

            // we assume a ':' in name means they are just adding an address with public key in it
            const wallet = name.indexOf(':') === -1 ? userWallet.generate(name) : userWallet.getUser(name)
            if( wallet.error ){
                debug('red', wallet.error)
                break
            }
            
            console.log( `\n> ${name.indexOf(':') === -1 ? 'Created' : 'Added'}! *${wallet.name}* with publicKey(${wallet.publicKey})` )

            // broadcast to a miner: don't share privateKey (obviously)!
            delete wallet.privateKey
            response = await urlCall({ url: miner_url + 'wallet_sync', body: [ wallet ] })
            if( response.error ) return response

            console.log(`- synced to server:` )
            response.result.forEach( item=>{
                if( Object.values(item) == 'ok' )
                    console.log( ` * ${Object.keys(item)} confirmed sync'd` )
            } )
            break
            }
        case 'token-create': {
            token = param1
            const amount = param2
            const admin = userWallet.buildNameWithPublicKey(param3)
            if( param4 ) miner_url = formatURL(param4)

            if( admin.error || admin.startsWith('http') ){
                debug( `! Invalid token administrator. Please add one. ${admin.error || ''}`)
                return
            }
            if( !miner_url || miner_url.length<10 ){
                debug( `x Miner URL invalid, rejecting.`)
                return
            }
            const wallet = userWallet.getUser(admin)
            if( wallet.error || !wallet.privateKey ){
                debug( `Sorry, user '${admin}' does not have a privateKey on this node, and so can't administer a token issue.`)
                return
            }

            // get the transaction(s) to sign
            response = await urlCall({ url: miner_url + 'token/auth', body: { action: 'tokenCreate', token, amount, admin } })
            if( response.error ){
                console.log( response.error )
                return
            }
            const tokenAuth = response.result // { action, token, amount, fee, admin, transactions }

            // auth error checking
            if( tokenAuth.action !== 'tokenCreate' || tokenAuth.admin !== admin ){
                console.log( `Unable to create token as network rejected request.`)
                return
            }

            // now let's re-submit the signed transactions for finalizing token creation.
            let transactions = []
            for( const transaction of tokenAuth.transactions )
                // signer specified in transaction 'admin' field, hopefully they exist on our node
                transactions.push( userTransactionHandler.transactionSign(transaction, transaction.admin) )
            tokenAuth.transactions = transactions

            response = await urlCall({ url: miner_url + 'token/transactions', body: tokenAuth })
            if( response.error ) return response
            debug( `Attempting to create a token ( ${token} ) administered by '${admin}'... response:`, JSON.stringify(response) )
            const result = response.result
            if( result.error )
                debug( 'red', ` * token creation REJECTED transaction: ${result.error}` )
            else
                debug( 'green', ` * token creation accepted. [${userWallet.getNameOnly(result.src)}] Balance: ${token}${result.meta?.balance || '-'}; Hash: ${result.hash}` )
            break

        }

        // node api.js token-airdrop jax$100000 miner0 [miner-server-api-url]` )
        case 'token-airdrop': {
            let amount = param1
            const dest = userWallet.buildNameWithPublicKey(param2)
            if( param3 ) miner_url = formatURL(param3)
            
            if( dest.error ){ console.log( dest.error ); return }

            { [amount, token] = userTransactionHandler.extractTokenFromAmount( amount ) }

            // get the transaction(s) to sign
            response = await urlCall({ url: miner_url + 'token/auth', body: { action: 'tokenAirdrop', token, amount, dest } })
            if( response.error ) {
                console.log( response.error )
                return
            }
            const tokenAuth = response.result // { action, token, amount, fee, admin, transactions }
            
            if( tokenAuth.admin && tokenAuth.admin.startsWith('*root:') && process.env.BLOCKCHAIN_PRIVATEKEY )
                debug( 4, ` * privateKey for BASE_TOKEN available; good!`)
            else if( tokenAuth.admin && userWallet.getUser(tokenAuth.admin).privateKey )
                debug( 4, ` * privateKey for admin (${tokenAuth.admin}) of ${token} available; good!`)
            else {
                debug( 1, `<red>ERROR: Unable to proceed as missing privateKey for singing airdrop.</>`)
                return
            }

            // now let's re-submit the signed transactions for finalizing token creation (using privateKey we have for admin).
            let transactions = []
            for( const transaction of tokenAuth.transactions ){
                const signedTransaction = userTransactionHandler.transactionSign(transaction,tokenAuth.admin)
                transactions.push( signedTransaction )
            }
            tokenAuth.transactions = transactions

            response = await urlCall({ url: miner_url + 'token/transactions', body: tokenAuth })
            debug( 4, `Attempting to perform airdrop for ( ${token} ) administered by '${tokenAuth.admin}'...` )
            if( response.error ) {
                debug( 1, `<red>ERROR: ${response.error}</>` )
                return
            }

            
            const result = response.result
            if( result.error )
                debug( 'red', ` * token airdrop REJECTED transaction: ${result.error}` )
            else
                debug( 'green', ` * token airdrop accepted. [${userWallet.getNameOnly(dest)}] Balance: ${token}${result.meta?.balance || '-'};` )
            break

        }
        
        // node api.js transaction {sender} {receiver} {token?}{amount} transfer [miner-server-api-url]` )
        case 'send': {
            let dest = param2
            let amount = param3
            if( param4 ) miner_url = formatURL(param4)
            const note = param6 || ''

            { [amount, token] = userTransactionHandler.extractTokenFromAmount( amount, token ) }

            dest = userWallet.buildNameWithPublicKey(dest)
            if( dest.error || !dest || !miner_url ){
                debug( 1, `<red>ERROR: ${dest.error}</>` )
                return
            }

            // let's get the fee for transaction & seq
            const src = userWallet.buildNameWithPublicKey(name)
            if( src.error ){
                debug( 1, `<red>ERROR: ${src.error}</>` )
                return
            }
            const type = 'transfer'
            response = await urlCall({ url: miner_url + 'transaction/prepare', body: { src, dest, amount, token, type, note } })
            if( response.error ){
                debug( 1, `<red>ERROR: invalid transaction prepare request: ${response.error}</>` )
                return
            }

            let transaction = response.transaction
            // encrypt note for recipient only (if set)
            if( note.length>0 ){
                if( note.startsWith('*') ){ 
                    const srcWallet = userWallet.getUserOrCreate(src)
                    note = '*' + userWallet.sign(srcWallet.privateKey, note)
                    debug( 4, `<gray>! encrypted note: ${note}</>`)
                }
                transaction.note = note
            }

            // now we accept this fee and authorize/sign the transaction (with users last seq #)
            transaction = userTransactionHandler.transactionSign(transaction)
            // if( !transaction.error )
            if( transaction.error ){
                debug( 1, `<red>! Signing error: ${transaction.error}</>` )
                return
            }

            // post the signed transaction
            debug(  1, `- Queried server for fee/seq: [${userWallet.getNameOnly(src)}/${transaction.seq} -> ${userWallet.getNameOnly(dest)} ${transaction.token}${transaction.amount}] / ${transaction.type} + fee=$${transaction.fee}; signing & posting...` )
            response = await urlCall({ url: miner_url + 'transaction', body: transaction })
            if( response.error ){
                debug( 1, `<red>x mining server (${miner_url}) rejected it: ${response.error}</>`)
                return
            }
            const result = response.result
            if( result.error ){
                debug( 1, `<red>x mining server REJECTED transaction: ${result.error}</>` )
            } else {
                if( result.meta?.warning ) debug('cyan', `   ! Warning: Accepted but increased risk of failure because: ${result.meta.warning}` )

                debug( 1, `<green>\ mining server accepted (fee: ${result.fee}) - tx hash: ${result.hash}, expected sender balance: ${result.token}${result.meta?.balance}</>` ) // Seq: ${result.seq}, Fee: $${result.fee},
            }
            break
            }

        // node wallet.js deposit {miner-name} {receiver} {amount} [miner-server-api-url]` )
        // SAMPLE example. This will work when you put miner-name and use miner api URL; IRL only server could enter deposit
        case 'miner-deposit': {
            const src = name
            const dest = userWallet.buildNameWithPublicKey(param2)
            let amount = param3
            if( param4 ) miner_url = formatURL(param4)

            { [amount, token] = userTransactionHandler.extractTokenFromAmount( amount, token ) }

            if( dest.error ){
                debug( 3, `<red>${dest.error}</>` )
                return
            }

            // let's get the fee for transaction & seq
            const type = 'minerDeposit'
            response = await urlCall({ url: miner_url + 'transaction/prepare', body: { src, amount, token, type } })
            if( response.error ){
                debug( 'red', `  x invalid transaction prepare request, aborting:`, response )
                return
            }
            // now we accept this fee and authorize/sign the transaction (with users last seq #)
            let transaction = response.transaction

            // now, as the miner, we have to sign-off on the deposit (so we need private key for the miner)
            transaction = userTransactionHandler.transactionSign(transaction)
            // if( !transaction.error )
            if( transaction.error ){
                debug( 1, `<red>! Signing error: ${transaction.error}</>` )
                return
            }

            response = await urlCall({ url: miner_url + 'transaction', body: transaction })
            if( response.error ){
                debug( 'red', `   x mining server (${miner_url}) rejected it: ${response.error}`)
                return
            }

            const result = response.result
            if( result.error )
                debug( 'red', ` * mining server REJECTED transaction: ${result.error}` )
            else
                debug( 'green', ` * mining server accepted. [${userWallet.getNameOnly(src)}/${seq+1}] Balance: ${token}${result.meta.balance}; Hash: ${result.hash}` )
            break
            }

        case 'transaction-verify': {// merkle tree proof returned, thus proving the node has the transaction
            const hash = param1 // may be multiple hashes comma separated
            if( param2 ) miner_url = formatURL(param2)

            response = await urlCall({ url: miner_url + 'transaction/verify?hash=' + hash })
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
            if( param2 ) miner_url = formatURL(param2)

            response = await urlCall({ url: miner_url + 'transaction?hash=' + hash })
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
commandLineProcess()