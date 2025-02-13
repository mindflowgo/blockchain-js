# BlockChain Basics

## The Motivation
One of the best ways to truly understand something is to build it yourself.

Thus, the goal is to build a full-featured, although not production ready, blockchain solution. Built with the key security features of modern-day blockchains, fashioned around the core ideas of Bitcoin.

Built with javascript in way to try and keep code minimal, intuitive to understand, and self-evident.

### Blockchain Concepts Implemented
Built with core ideas like:
- immutable blocks with mining (BTC proof-of-work nonce), 
- mining rewards, 
- transaction fees, 
- transaction signing (thus wallets)
- transaction nonce/sequence (like Ethereum/XRP), slight departure/improvement over BTC

No database is used, all data is stored as text/zip files in a directory.

### Technologies Used
- Javascript ES6 through Node
- uWebsocket.js for fast websocket/http communication
- standard encryption technologies


## RUNNING A NODE
node server.js debug miner1 5000
(will listen on localhost:5000)


Once a miner is running, you can call it directly:

### Increase mint supply
`curl --data '[{"src":"_","dest":"_mint","amount":"2000000","type":"mintIssue"}]' http://localhost:5000/transactions`

### Grant Money to Miner
`curl --data '[{"src":"_mint","dest":"miner1","amount":"202","type":"mintAirDrop"}]' http://localhost:5000/transactions`

### User Deposit @ Miner
// generate the user locally first, as we need a public/private key
`node ledger.js create fil`

Now use the name + publicKey to perform transaction on miner to deposit into users account
`curl --data '[{"src":"miner1","dest":"fil:HTzFU2orJH5tmyd3UMsUyLYVn3igRjEGqoRjjarKWembA","amount":"200","type":"minerDeposit","seq":1}]' http://localhost:5000/transactions`


Now you have a user with money on their blockchain. You can have them send to other users:

Create a new user:
`node ledger.js create fred`

### Send money from your wallet to someone else (both need to have a valid wallet created)
`node ledger.js transaction fil fred 1.369 transfer http://localhost:5000`

If you did the minerDeposit above, your user (fil) will be known to the mining server. Your computer will send the publicKey for you and fred, and so the mining server will be able to make a public record of the transfer of money from fil to fred's account. Your computer will sign this transaction before sending it, so everyone knows that only you authorized it.


### Get Merkle Proof for a transaction
Merkle proofs allow a user to know with certainty that a node server has a transaction, as it would not able to provide the intermittent hashes without having all the transactions to calculate them. 

`node ledger.js transaction-verify 831isZBdqs8qnSziZuVjimnoWFmMxX8HW7uszFfoUd24,6Knq7UoWrKxGcvoVmRy15E8iXCmCmTjDrmZTLb8dG8bX http://localhost:5000`


### UI
If you're interested in helping build out this project or the UI for it, get in touch. 
