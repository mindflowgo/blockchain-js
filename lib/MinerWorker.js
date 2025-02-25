/******************************************
 * Mining Worker Thread
 * 
 * (c) 2025 Filipe Laborde / fil@rezox.com
 * 
 * MIT License
 * 
 * This is simply the mining thread. It is passed a block and difficulty level
 * and grinds away calculating hashes with incremental nonces till we get a
 * match level. It then posts back the nonce it found.
 * 
 * It can be used in a mining pool method with multiple instances each doing 
 * different ranges of nonces
 * 
 * Incoming actions: 
 * ABORT: stops mining (if mining)
 * MINE: takes the {difficulty, block} and finds working nonce
 * 
 * Outgoing communication
 * UPDATE: pings parent with occasional updates while mining
 * SOLVED: submits the solved block
 * ABORT: indicates it completed abort process
 */

import { parentPort, workerData } from 'worker_threads'
import { urlCall, sha256Hash, fixRounding, time, wait } from './helper.js'

let difficulty = 1
let mining = false

async function generateProofOfWork(block, nonceStart, nonceEnd) {
    const start = time()
    mining = true

    const hashPrefix = '0'.repeat(difficulty)
    console.log( `\n .. [Worker] starting mining #${block.index} (difficulty: ${difficulty})` )

    // find a hash that starts with some number of '0's, as per BTC paper
    let nonceFound = false
    block.nonce = nonceStart - 1
    do {
        block.nonce++
        block.hash = sha256Hash( 
            [block.index, block.prevHash, block.version, block.timestamp, block.minerName, block.merkleRoot, block.nonce, 
                block.transactions], 'hex')

        if( block.nonce > 0 && block.nonce%1000000 === 0 ){
            // update our blockchain pow tracker
            await wait(20) // unlock so we can check value of mining variable
            console.log( ` .. [Worker] running mining(${mining})`)
            parentPort.postMessage({ action: 'UPDATE', nonce: block.nonce, elapsed: time()-start })
        }

        if( block.hash.startsWith(hashPrefix) && !block.hash.startsWith(hashPrefix+'0') ) nonceFound = true
    } while (!nonceFound && mining && (nonceEnd == -1 || block.nonce <= nonceEnd) )

    const elapsed = time() - start
    // if mining was stopped then report error
    if( !nonceFound )
        if( !mining )
            return { error: ` .. [Worker] ABORTED #${block.index} (${elapsed}s`, elapsed }
        else
            return { error: ` .. [Worker] nonce range[${nonceStart}:${nonceEnd}] tried, not found.`, elapsed, nonceStart, nonceEnd }

    // track time to generate PoW (in seconds)
    block.powTime = elapsed
    console.log( ` .. [Worker] COMPLETE, found nonce (${block.powTime}s) for #${block.index} hash=${block.hash}` )
    return { error: false, elapsed, block }
}

// Listen for messages from the main thread
parentPort.on('message', async ({ action, ...data }) => {
    switch( action ){
        case 'ABORT':
            console.log(` .. [Worker] Aborting message received.`)
            // toggle mining off, if we are currently mining there will be some delay before it leaves generateProofOfWork() and responds
            // if it's NOT mining, immediately respond with ABORT
            if( !mining )
                parentPort.postMessage({ action: 'ABORT', elapsed: 0 })
            
            // toggle mining off so it will then trigger ABORT 
            mining = false
            break
        
        case 'MINE':
            difficulty = data.difficulty
            const nonceStart = data.nonceStart || 0
            const nonceEnd = data.nonceEnd || -1
            const { error, block, elapsed }= await generateProofOfWork(data.block,nonceStart,nonceEnd)
            if( !error )
                parentPort.postMessage({ action: 'SOLVED', elapsed, block })
            else if( mining ) // error likey because failed in nonse-scan range
                parentPort.postMessage({ action: 'UNSOLVED', elapsed, nonceStart, nonceEnd })
            else
                parentPort.postMessage({ action: 'ABORT', elapsed, nonceStart, nonceEnd })

            mining = false
            break
    }
})
