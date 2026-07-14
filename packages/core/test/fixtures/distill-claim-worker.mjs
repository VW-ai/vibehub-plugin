import {parentPort,workerData} from "node:worker_threads";
import {openDb,OperationDispatcher} from "../../dist/index.js";
const gate=new Int32Array(workerData.gate);const arrived=Atomics.add(gate,0,1)+1;if(arrived<2)Atomics.wait(gate,0,arrived,5000);else Atomics.notify(gate,0);
const db=openDb(workerData.dbPath);try{parentPort.postMessage(new OperationDispatcher(db).dispatch("distill.scopes.claim",workerData.context,workerData.input));}finally{db.close();}
