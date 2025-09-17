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

import { isMainThread, parentPort, Worker } from 'worker_threads'
import path from 'path'

import { time, wait, debug } from './helper.js'
import Block from './Block.js'

// from .env
const MINING_TIMEOUT = process.env.MINING_TIMEOUT                 // if mining hanging, reset to READY after this time
const MINING_PAUSE_TIMEOUT = process.env.MINING_PAUSE_TIMEOUT     // if paused kill it after 120s

export default class MinerWorker {
    constructor( nodeName, dataPath, fnBlockchainDifficulty ) {
        this.nodeName = nodeName
        this.dataPath = dataPath
        this.status = 'IDLE'
        this.elapsed = 0
        this.fnBlockchainDifficulty = fnBlockchainDifficulty
        
        // creating Worker-thread instance
        this.node = new Worker(path.resolve('./lib', 'MinerWorker.js'))

      
    } // /constructor

    // MINING --> wait for message: CLEANUP, SOLVED
    async mineBlock( blockData ) {
        return new Promise((resolve,reject) => {
            this.status = 'MINING'
            this.node.postMessage({action: 'MINE', blockData, nodeName: this.nodeName, dataPath: this.dataPath, difficulty: this.fnBlockchainDifficulty() })

            // listen to incoming messages from miner
            this.node.on('message', ({ action, ...result }) => {
                switch( action ){
                    case 'UPDATE':
                        debug('dim',`  ~ [Miner] Worker update (nonce=${result.nonce}, elapsed=${result.elapsed}s)`)
                        this.elapsed = result.elapsed
                        break
                    case 'DONE_TIMEOUT':
                    case 'DONE_ABORTED':
                    case 'DONE_UNSOLVED':
                        debug('dim',`  ~ [Miner] Worker notified ${action}; elapsed=${result.elapsed}s. Ready again.`)
                        this.status = 'IDLE'
                        resolve({action})
                        break
                    case 'DONE_SOLVED':
                        this.status = 'IDLE'
                        resolve({action, blockData: result.blockData})
                        break
                    default:
                        break
            }})

            this.node.on('error', (error) => {
                debug('red', '  ~ [Miner] Worker ERROR:', error)
                reject(error)
            })

            this.node.on('exit', (code) => {
                debug('red', `  ~ [Miner] Worker DIED with exit code ${code}`); // code 0 = normal
                reject(`Miner died on exit code ${code}`)
            })
        })

    }

    stopMining() {
        this.node.postMessage({action: 'ABORT'})
    }

    pauseMining() {
        this.node.postMessage({action: 'PAUSE'})
    }

    continueMining() {
        this.node.postMessage({action: 'UNPAUSE'})
    }

    // static used by the actual miner instance without instantiation
    static {
        this.mining = false
        this.paused = false
        this.lastUpdate = 0
        this.pauseTimeout = null
        this.mineTimeout = null
    }
}

// this ONLY runs on the WORKER THREAD
// it doesn't create a class instance, saving memory, just uses static variables
if( !isMainThread && parentPort ){
    // this instance is the actual worker side.
    // Listen for messages from the main thread
    parentPort.on('message', async ({ action, ...data }) => {
        switch( action ){
            case 'PAUSE':
            case 'UNPAUSE':
                if( !MinerWorker.mining ) break
                MinerWorker.paused = action === 'PAUSE' ? true : false
                // clear, reset pause timeout
                if( MinerWorker.pauseTimeout ) clearTimeout( MinerWorker.pauseTimeout )
                MinerWorker.pauseTimeout = setTimeout( ()=>{ parentPort.postMessage({ action: 'DONE_TIMEOUT' }) }, MINING_PAUSE_TIMEOUT )
                break
            case 'ABORT':
                console.log(` .. [Worker] Aborting message received.`)
                if( MinerWorker.pauseTimeout ) clearTimeout( MinerWorker.pauseTimeout )
                if( MinerWorker.mineTimeout ) clearTimeout( MinerWorker.mineTimeout )
                // toggle mining off, if we are currently mining there will be some delay before it leaves generateProofOfWork() and responds
                // if it's NOT mining, immediately respond with ABORT
                if( !MinerWorker.mining )
                    parentPort.postMessage({ action: 'DONE_ABORTED', elapsed: 0 })
                
                // toggle mining off so it will then trigger ABORT 
                MinerWorker.mining = false
                MinerWorker.paused = false
                break
            
            case 'MINE':
                if( MinerWorker.mineTimeout ) clearTimeout( MinerWorker.mineTimeout )
                MinerWorker.mineTimeout = setTimeout( ()=>{ parentPort.postMessage({ action: 'DONE_TIMEOUT' }) }, MINING_TIMEOUT )

                const { blockData: minableBlock, nodeName, dataPath, difficulty, nonceStart, nonceIterations }= data
                // create a temp block to run mine method on - forceOverwrite to prevent it trying to read real-block data
                const block = new Block(minableBlock, { forceOverwrite: true, nodeName, dataPath }) 
                const iterationAttempts = 1000000
                let nonceValidHash = false
                for( const nonce = nonceStart || 0; nonce < Number.MAX_SAFE_INTEGER; nonce += iterationAttempts ) {
                    nonceValidHash = block.mine(difficulty, nonce, iterationAttempts)
                    if( nonceValidHash || !MinerWorker.mining ) break
                    // loop if paused
                    do { 
                        await wait(100) // unlock so we can check value of mining variable
                        if( (time() - MinerWorker.lastUpdate) > 15 ) {
                            MinerWorker.lastUpdate = time()
                            parentPort.postMessage({ action: 'UPDATE', nonce, paused: MinerWorker.paused, elapsed: block.powTime })
                        }
                    } while( MinerWorker.paused )
                }

                clearTimeout( MinerWorker.mineTimeout )
                
                // loop ended so either found result (with break) or minig stopped
                const elapsed = block.powTime
                if( nonceValidHash )
                    parentPort.postMessage({ action: 'DONE_SOLVED', elapsed, blockData: block.getData() })
                else if( MinerWorker.mining ) // error likey because failed in nonse-scan range
                    parentPort.postMessage({ action: 'DONE_UNSOLVED', elapsed })
                else
                    parentPort.postMessage({ action: 'DONE_ABORTED', elapsed })

                MinerWorker.mining = false
                break
        }
    })
}
