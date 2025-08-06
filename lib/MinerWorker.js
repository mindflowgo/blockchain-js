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

import { parentPort } from 'worker_threads'
import { time, wait } from './helper.js'
import Block from './Block.js'

let mining = false

async function mineBlock(block, difficulty, nonceStart, nonceEnd) {
    const start = time()
    mining = true

    console.log( `\n .. [Worker] starting mining #${block.index} (difficulty: ${difficulty})` )

    // find a hash that starts with some number of '0's, as per BTC paper
    let nonceFound = false
    block.nonce = nonceStart
    do {
        // only mine for 1M tries, then we check if continue mining or not
        nonceFound = block.mine( difficulty, nonceEnd === -1 ? 1000000 : Math.min(1000000,nonceEnd-block.nonce) )
        // update our blockchain pow tracker
        await wait(100) // unlock so we can check value of mining variable
        console.log( ` .. [Worker] running mining(${mining})`)
        parentPort.postMessage({ action: 'UPDATE', nonce: block.nonce, elapsed: time()-start })
    } while( !nonceFound && mining )

    const elapsed = time() - start
    // if mining was stopped then report error
    if( !nonceFound )
        if( !mining )
            return { error: ` .. [Worker] ABORTED #${block.index} (${elapsed}s`, elapsed }
        else
            return { error: ` .. [Worker] nonce range[${nonceStart}:${nonceEnd}] tried, not found.`, elapsed, nonceStart, nonceEnd }

    // track time to generate PoW (in seconds)
    block.powTime = elapsed
    console.log( ` .. [Worker] COMPLETE, found nonce (${block.nonce} taking ${block.powTime}s) for #${block.index}` )
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
            const difficulty = data.difficulty
            const nonceStart = data.nonceStart || 0
            const nonceEnd = data.nonceEnd || -1
            // create a temp block to run mine method on - forceOverwrite to prevent it trying to read real-block data
            const block = new Block(data.block, { forceOverwrite: true }) 
            const { error, elapsed }= await mineBlock(block, difficulty, nonceStart, nonceEnd)
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
