/******************************************
 * Mining Worker Thread
 * 
 * (c) 2025 Filipe Laborde / fil@rezox.com
 * 
 * MIT License
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
import { urlCall, sha256Hash, fixRounding, time } from './helper.js'

let difficulty = 1
let mining = false

function generateProofOfWork(block) {
    const start = time()
    mining = true

    const hashPrefix = '0'.repeat(difficulty)
    console.log( ` .. [Worker] starting mining #${block.index} (difficulty: ${difficulty})` )

    // find a hash that starts with some number of '0's, as per BTC paper
    do {
        block.nonce++
        block.hash = sha256Hash( 
            [block.index, block.prevHash, block.version, block.timestamp, block.minerName, block.merkleRoot, block.nonce, 
                block.transactions], 'hex')

        if( block.nonce%1000000 === 0 )
            // update our blockchain pow tracker
            parentPort.postMessage({ action: 'UPDATE', nonce: block.nonce, elapsed: time()-start })
    } while (!block.hash.startsWith(hashPrefix) && mining)

    // if mining completed successfully (vs mining flag toggled off)
    if( mining ){
        // track time to generate PoW (in seconds)
        block.powTime = time() - start
        console.log( ` .. [Worker] COMPLETE #${block.index} (${block.powTime}s)` )
        mining = false
        return block
    }
    return false
}

// Listen for messages from the main thread
parentPort.on('message', ({ action, ...data }) => {
    switch( action ){
        case 'ABORT':
            mining = false
            break
        
        case 'MINE':
            difficulty = data.difficulty
            const powBlock = generateProofOfWork(data.block)
            if( powBlock )
                parentPort.postMessage({ action: 'SOLVED', block: powBlock })
            else
                parentPort.postMessage({ action: 'ABORT' })
            break
    }
})
