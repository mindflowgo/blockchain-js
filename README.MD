# Blockchain Basics

## Motivation
One of the best ways to truly understand something is to build it yourself. The goal of this project is to build a full-featured, although not production-ready, blockchain solution. It incorporates the key security features of modern-day blockchains and is inspired by the core ideas of Bitcoin.

The blockchain is built using JavaScript to keep the code minimal, intuitive, and self-evident.

### Implemented Blockchain Concepts
The blockchain includes the following core features:
- **Immutable blocks** with mining (Bitcoin-style proof-of-work nonce)
- **Mining rewards**
- **Transaction fees**
- **Transaction signing** (enabling wallets)
- **Transaction nonce/sequence** (similar to Ethereum/XRP, a slight improvement over Bitcoin)

No database is used; all data is stored as text/zip files in a directory.

### Technologies Used
- **JavaScript ES6** via Node.js
- **uWebSockets.js** for fast WebSocket/HTTP communication
- Standard encryption technologies

---

## RUNNING A NODE
```bash
node server.js debug miner1 5000
```
(will listen on localhost:5000)


Once a miner is running, you can call it directly:

### Increase mint supply
```bash
curl --data '[{"src":"_","dest":"_mint","amount":"2000000","type":"mintIssue"}]' http://localhost:5000/transactions
```

### Grant Money to Miner
```bash
curl --data '[{"src":"_mint","dest":"miner1","amount":"202","type":"mintAirDrop"}]' http://localhost:5000/transactions
```

### User Deposit @ Miner
// generate the user locally first, as we need a public/private key
```bash
node ledger.js create fil
```

Now use the name + publicKey to perform transaction on miner to deposit into users account
```bash
curl --data '[{"src":"miner1","dest":"fil:HTzFU2orJH5tmyd3UMsUyLYVn3igRjEGqoRjjarKWembA","amount":"200","type":"minerDeposit","seq":1}]' http://localhost:5000/transactions
```

Now you have a user with money on their blockchain. You can have them send to other users:

Create a new user:
```bash
node ledger.js create fred
```

### Send money from your wallet to someone else (both need to have a valid wallet created)
```bash
node ledger.js transaction fil fred 1.369 transfer http://localhost:5000
```

If you did the minerDeposit above, your user (fil) will be known to the mining server. Your computer will send the publicKey for you and fred, and so the mining server will be able to make a public record of the transfer of money from fil to fred's account. Your computer will sign this transaction before sending it, so everyone knows that only you authorized it.


### Get Merkle Proof for a transaction
Merkle proofs allow a user to know with certainty that a node server has a transaction, as it would not able to provide the intermittent hashes without having all the transactions to calculate them. 

```bash
node ledger.js transaction-verify 831isZBdqs8qnSziZuVjimnoWFmMxX8HW7uszFfoUd24,6Knq7UoWrKxGcvoVmRy15E8iXCmCmTjDrmZTLb8dG8bX http://localhost:5000
```


### UI
If you're interested in helping build out this project or the UI for it, get in touch. 
