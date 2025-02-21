# Blockchain JS

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

When transactions occur, if they are new to a node, and signed properly, the node will announce it to all it's peers. It will then take the bank of the pendingTransactionss, ordered by (using SQL to model) - priority types (deposit, mint issue), then signed transactions, then the functional fees, block rewards -- each of these groups ordered by timestamp, user/seq:
```sql
ORDER BY type='minerDeposit' || type='mintIssue' DESC, txSig <> '' DESC, timestamp ASC, src ASC, seq ASC  LIMIT 10
```

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

### User Deposit in Miner; then Withdraw to User
// generate the user locally first, as we need a public/private key
// note the api-url and the miner nodeName must be same (because other nodes don't know publicKey for 'miner0', except their own server)
```bash
node ledger.js create fil
node ledger.js miner-deposit miner0 fil 500 http://localhost:5000/
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

### Checking Balances
You can check the balances on accounts with a server:
```bash
node ledger.js wallets fil,miner0:93Wag45TTBijDVg696N5VqjtbmMagGKbZc7W5kLoty8xZ http://localhost:5000
```

### TESTING ###
# Try overloading it
node ledger.js transaction fil fred 1.369 transfer http://localhost:5001 && \
node ledger.js transaction fil fred 2.369 transfer http://localhost:5003 && \
node ledger.js miner-deposit miner1 fil 200 http://localhost:5001 && \
node ledger.js transaction fil fred 1.369 transfer http://localhost:5000 && \
node ledger.js transaction fil olga 1.369 transfer http://localhost:5001 && \
node ledger.js transaction olga evan 1.369 transfer http://localhost:5003

# Check balances match across servers after transactions
node ledger.js wallets ALL http://localhost:5000 && \
node ledger.js wallets ALL http://localhost:5001 && \
node ledger.js wallets ALL http://localhost:5003

### UI
If you're interested in helping build out this project or the UI for it, get in touch. 
