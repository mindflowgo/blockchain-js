import { urlCall, sha256Hash, fixRounding, time } from './lib/helper.js'

// sample BLOCK
const block =  {
    index: 30,
    prevHash: '00015b2894838232c5680cf2945d7d35c8af8c3d44766cdef87ae2b17cf9aac2',
    version: '0:1.0',
    timestamp: Date.now(),
    minerName: 'testMiner',
    merkleRoot: 'BSJFCNMHBNiTb6Wm771qCWd2rByWGEBp2wcUriHTJAWZ',
    nonce: 87927,
    transactions: [
        {
        timestamp: 1739424393,
        src: 'user1:HTzFU2orJH5tmyd3UMsUyLYVn3igRjEGqoRjjarKWembA',
        dest: 'user2:3fTEYzyLtwpYPA59P5z5mNLw54otJkbXb4ntkRPy81y37',
        amount: 2,
        fee: 0.02,
        type: 'transfer',
        seq: 40,
        txSig: '3C2MqqrN55B2gtyvWJmozSJrZpqmH8m5zyHwnR4wBFwbQtiDCja3uUwFAu46gNn9V2LMaf5DxuaVZSAoEW5uV8WjTNB2ajAEPcCLx79n95fAFtytpVmMGsRpZSPkNnwaCYdv1ZrsmEA4LZcJ53EX',
        hash: '9cGqBK2CcZxCbVPrNsDHENn2QJ5aH4f6JEFNRtpocAih'
        },
        {
        timestamp: 1739424421,
        src: '_mint',
        dest: 'miner1:FccDd1VVqwoPi4WM4ASGUuW5kDoDL8JmXFWRAxwdZGiF4',
        amount: 0.02,
        fee: 0,
        type: 'miningFees',
        seq: 94,
        source: '9cGqBK2CcZxCbVPrNsDHENn2QJ5aH4f6JEFNRtpocAih',
        hash: 'CqQ2k5chdsTUKXdjxZPpLVHCTy85EpNzm3U6sfJZwcFx'
        },
        {
        timestamp: 1739424421,
        src: '_mint',
        dest: 'miner1:FccDd1VVqwoPi4WM4ASGUuW5kDoDL8JmXFWRAxwdZGiF4',
        amount: 12.5,
        fee: 0,
        type: 'miningReward',
        seq: 95,
        hash: 'vJJh6WWCn6cKTyHGXqMxhcMYMmfCTedeHDKbQTT7GZW'
        }
    ],
    powTime: 1,
    nodeName: 'miner1',
    compress: false,
    dataPath: './data',
    hash: '000029fc64ece1900a2e9a3a6092b13359955adea8d7a14953efdf4ab9abb704'
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
