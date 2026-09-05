// osc-test.js
import osc from 'osc';

const udpPort = new osc.UDPPort({
  localAddress: "0.0.0.0",
  localPort: 9001 // VRChat's default OSC output port
});

udpPort.on("message", (oscMsg) => {
  if (oscMsg.address.includes("Proximity")) {
    console.log(oscMsg.address, oscMsg.args);
  }
});

udpPort.open();
console.log("Listening on 9001...");
