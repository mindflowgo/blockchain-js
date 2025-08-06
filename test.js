// import crypto from 'crypto'
// import bs from 'bs58'
// // generates 32-byte ed25519 keys (more compact) than crypto library
// import nacl from 'tweetnacl'


// // Generate Ed25519 key pair (32-byte public key)
// const keyPair = crypto.generateKeyPairSync('ed25519', {
//     publicKeyEncoding: {
//         type: 'spki',
//         format: 'der' // or 'der' if you prefer binary
//     },
//     privateKeyEncoding: {
//         type: 'pkcs8',
//         format: 'der' // or 'der'
//     }
// });

// console.log("Public Key (PEM):", bs.encode(keyPair.publicKey));
// console.log("Private Key (PEM):", bs.encode(keyPair.privateKey));

// // If you want raw 32-byte public key (Buffer):
// const rawPublicKey = crypto.createPublicKey(keyPair.publicKey)
//     .export({ format: 'pem', type: 'spki' })
//     .subarray(-32); // Last 32 bytes = the actual Ed25519 public key

// console.log("Raw Public Key (32 bytes):", rawPublicKey.toString('hex'));



// const keyPair3 = crypto.generateKeyPairSync('ec', {
//     namedCurve: 'secp256k1',
//     publicKeyEncoding: { type: 'spki', format: 'der' },
//     privateKeyEncoding: { type: 'pkcs8', format: 'der' }
// })
// console.log( keyPair3 )
// console.log( `secp256k1: public(${bs.encode(keyPair3.publicKey)}), private(${bs.encode(keyPair3.privateKey)})` )
        
// const keyPair2 = nacl.sign.keyPair()
// console.log( keyPair2 )
// const publicKey2 = bs.encode(Buffer.from(keyPair2.publicKey))
// const privateKey2 = bs.encode(Buffer.from(keyPair2.secretKey))

// console.log( `ed25519: public(${bs.encode(publicKey2)}), private(${bs.encode(privateKey2)})` )


import uWS from 'uWebSockets.js' // npm install uNetworking/uWebSockets.js#v20.51.0
// import WebSocket from 'ws';
import { handleGET, handlePOST, debug } from './lib/helper.js'

    const nodeName = 'moo'
    const host = 'localhost'
    let port = 5000

    async function main() {

        // now run webserver to engage with network
        uWS.App({ /* cert_file_name: cert, key_file_name: key */})
        .get('/transactions', handleGET((res, req) => {
            debug('dim', `>> [${req.nodeToken}]${req.url}?${req.getQuery()}`)

            const result = "boom"
            res.end( JSON.stringify({ error: false, result }) )
            }, 'ONLINE'))

        .get('/blocks', handleGET((res, req) => {
            console.log( `/blocks called`)
            result = "{test}"
            res.end( JSON.stringify({ error: false, result }) )
            }, 'ONLINE' ))
        
        .post('/node/announce', handlePOST(async (info,head) => {
            debug( 'dim', `>> /node/announce','')})` )

            
            return { error: false, result: "hello world" }
            }, 'ONLINE' ))

        .any('/*', (res, req) => {
            /* Wildcards - make sure to catch them last */
            debug( 'dim', `>> invalid request: ${req.getUrl()}` )
            res.end( JSON.stringify({ error: `Invalid request: '${req.getUrl()}'` }) )
            })
            
        .listen(host, port, (token) => {
            if (token) {
                // port = uWS.us_socket_local_port(token)
                debug('green', `Running peers token`, token)
            } else {
                debug('red', 'Failed finding available port')
                process.exit(-1)
            }
        })
    }

    main().catch(err => {
        debug('red',err)
    })
