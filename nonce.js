import { sha256Hash, fixRounding, time } from './lib/helper.js'

// sample BLOCK
const block2 =  {
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
        txAuth: '3C2MqqrN55B2gtyvWJmozSJrZpqmH8m5zyHwnR4wBFwbQtiDCja3uUwFAu46gNn9V2LMaf5DxuaVZSAoEW5uV8WjTNB2ajAEPcCLx79n95fAFtytpVmMGsRpZSPkNnwaCYdv1ZrsmEA4LZcJ53EX',
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

const block = {
    index: 29,
    prevHash: '000092ab66141988b251a8337d393c0b2d1fa997c2a85b360c5b4dbb826c8615',
    version: '0:1.0',
    timestamp: 1739809629,
    minerName: 'miner3',
    merkleRoot: '2NjYKkotNXdnnqqWCDPhnV3uzDWJJnWsaUm9ho7mAXtj',
    nonce: 153691,
    transactions: [
      {
        timestamp: 1739809623,
        src: 'eric:5w1WLGXYypPQDj9i84tPFnoRdXQzq9ZGx87uzNUEctyUo',
        dest: 'fil:HTzFU2orJH5tmyd3UMsUyLYVn3igRjEGqoRjjarKWembA',
        amount: 5,
        fee: 0.05,
        type: 'transfer',
        seq: 17,
        txAuth: '3jX4pWV2x8Rs4Ye4fuCNv3CN9SPypub8y8HF5yXqZ9JNzTppHYq8Cf1h9qPy2zkTcdoHFj8PbTCVJ3ZUq57x6preYgfhogWd8gp1JgNb5PvgDh7UGsNC2WuEDZtWSeixpcQXkgeZhySiWo6MR16b',
        hash: 'CfC97NJsog7pSk6HTUFdqgQuDCs3YLghrSe4BxKWKNid'
      },
      {
        timestamp: 1739809629,
        src: '_mint',
        dest: 'miner3:BZExLZ89y6AZdRhhZzWbspiFLpasMsEXMNi94PjH8BdpP',
        amount: 0.05,
        fee: 0,
        type: 'miningFees',
        seq: 53,
        source: 'CfC97NJsog7pSk6HTUFdqgQuDCs3YLghrSe4BxKWKNid',
        hash: 'DLy4WYNyx8Bux4WVFA9vpGFweELPK6AoZynW9yJ7WTKp'
      },
      {
        timestamp: 1739809629,
        src: '_mint',
        dest: 'miner3:BZExLZ89y6AZdRhhZzWbspiFLpasMsEXMNi94PjH8BdpP',
        amount: 25,
        fee: 0,
        type: 'miningReward',
        seq: 54,
        hash: '4o3o7tnSSP6DSzZGofTvhZY9SbX4RAcEDrHsFdbnr217'
      }
    ],
    powTime: 1,
    nodeName: 'miner1',
    compress: false,
    dataPath: './data',
    hash: '0ebd08c61ed7c5983f0b3c3d44625c3dd68ebca2e64f59cec19dda520d7f7c83'
}

if( process.argv.length<3 ){
    console.log( `NONCE options:`)
    console.log( `- node nonce.js 4` )
    process.exit()
}
const difficulty = process.argv[2]
const hashPrefix = '0'.repeat(difficulty)

console.log( `Nonce=${difficulty}, finding hash: ${hashPrefix}xxxxxxxxxxxxx)`)

let data = ' [29,"000092ab66141988b251a8337d393c0b2d1fa997c2a85b360c5b4dbb826c8615","0:1.0",1739809629,"miner3","2NjYKkotNXdnnqqWCDPhnV3uzDWJJnWsaUm9ho7mAXtj",%%nonce%%,[{"timestamp":1739809623,"src":"eric:5w1WLGXYypPQDj9i84tPFnoRdXQzq9ZGx87uzNUEctyUo","dest":"fil:HTzFU2orJH5tmyd3UMsUyLYVn3igRjEGqoRjjarKWembA","amount":5,"fee":0.05,"type":"transfer","seq":17,"txAuth":"3jX4pWV2x8Rs4Ye4fuCNv3CN9SPypub8y8HF5yXqZ9JNzTppHYq8Cf1h9qPy2zkTcdoHFj8PbTCVJ3ZUq57x6preYgfhogWd8gp1JgNb5PvgDh7UGsNC2WuEDZtWSeixpcQXkgeZhySiWo6MR16b","hash":"CfC97NJsog7pSk6HTUFdqgQuDCs3YLghrSe4BxKWKNid"},{"timestamp":1739809629,"src":"_mint","dest":"miner3:BZExLZ89y6AZdRhhZzWbspiFLpasMsEXMNi94PjH8BdpP","amount":0.05,"fee":0,"type":"miningFees","seq":53,"source":"CfC97NJsog7pSk6HTUFdqgQuDCs3YLghrSe4BxKWKNid","hash":"DLy4WYNyx8Bux4WVFA9vpGFweELPK6AoZynW9yJ7WTKp"},{"timestamp":1739809629,"src":"_mint","dest":"miner3:BZExLZ89y6AZdRhhZzWbspiFLpasMsEXMNi94PjH8BdpP","amount":25,"fee":0,"type":"miningReward","seq":54,"hash":"4o3o7tnSSP6DSzZGofTvhZY9SbX4RAcEDrHsFdbnr217"}]]'
const start = time()
let nonce = 0
let elapsed
// find a hash that starts with some number of '0's, as per BTC paper
do{
    nonce++
    const flatBlock = data.replace('%%nonce%%', nonce)
    block.hash = sha256Hash(flatBlock,'hex')
    if( nonce%20000000 === 0 ){
        elapsed = Math.round((time() - start)/6)/10
        console.log( ` - ${elapsed} mins passed, nonce(${nonce}), ...`)
    }
} while (!block.hash.startsWith(hashPrefix))
    
// track time to generate PoW
elapsed = Math.round((time() - start)/6)/10
block.powTime = elapsed
console.log( `Found! Time taken: ${elapsed} mins: nonce(${nonce}) ${block.hash}` )
