import { urlCall, sha256Hash, fixRounding, time } from './lib/helper.js'

// sample BLOCK
const block = {
    index: 6,
    prevHash: "00579dfa787a63f5349af514ed974b5a669e7ec84b0276825e28618de29a9fdb",
    timestamp: Date.now(),
    minerName: "testMiner",
    nonce: 0,
    powTime: 0,
    transactions: [
        {
        timestamp: 1739060111,
        sender: "fil:5zE52EzkbQBkQRC52c7U6rqXNwUCXpddiMothz571i34",
        receiver: "greg:4p845bnZRQDnqqnAVafxBoYHtz1jJbq6Bh6fpy2rq336",
        amount: 1,
        fee: 0.01,
        txSig: "2bd6uxSnDiuJmyD4Vq4hGYzj1nETe1hQFcW89MFtA55S2hSfVoRae8r3sHM6LmMnzKh15c2gXcwobRxbid1eFP5VDiB1hKToGuBdjbG9kuAVEeg6Tsz166WJPnJgxUGaY1frZogwUUdZLpqSEsnAL"
        }
    ],
    hash: '00'
}

if( process.argv.length<3 ){
    console.log( `NONCE options:`)
    console.log( `- node nonce.js 4` )
    process.exit()
}
const difficulty = process.argv[2]
const hashPrefix = '0'.repeat(difficulty)

console.log( `Nonce=${difficulty}, finding hash: ${hashPrefix}xxxxxxxxxxxxx)`)

const start = time()
let nonce = 0
let elapsed
// find a hash that starts with some number of '0's, as per BTC paper
while (!block.hash.startsWith(hashPrefix)) {
    nonce++
    block.hash = sha256Hash(block,'hex')
    if( nonce%20000000 === 0 ){
        elapsed = Math.round((time() - start)/6)/10
        console.log( ` - ${elapsed} mins passed, nonce(${nonce}), ...`)
    }
}
// track time to generate PoW
elapsed = Math.round((time() - start)/6)/10
block.powTime = elapsed
console.log( `Found! Time taken: ${elapsed} mins: nonce(${nonce}) ${block.hash}` )
