import readline from "readline";
import { initOsc, send, setAxis, stopMovement } from "./osc.js";
import { say } from "./chatbox.js";

initOsc();

console.log(`
Manual test console. Commands:
  w              - move forward (pulse)
  s              - stop moving
  a / d          - turn left / right (pulse)
  say <text>     - send chatbox text
  raw <addr> <val> - send a raw OSC float, e.g: raw /input/Jump 1
  q              - quit
`);

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
    const [cmd, ...rest] = line.trim().split(" ");
    const arg = rest.join(" ");

    switch (cmd) {
        case "w":
            send("/input/MoveForward", { type: "i", value: 1 });
            setTimeout(() => send("/input/MoveForward", { type: "i", value: 0 }), 500);
            console.log("-> forward pulse");
            break;
        case "s":
            send("/input/MoveForward", { type: "i", value: 0 });
            send("/input/MoveBackward", { type: "i", value: 0 });
            console.log("-> stopped");
            break;
        case "a":
            setAxis("/input/LookHorizontal", -0.6);
            setTimeout(() => setAxis("/input/LookHorizontal", 0), 300);
            console.log("-> turn left pulse");
            break;
        case "d":
            setAxis("/input/LookHorizontal", 0.6);
            setTimeout(() => setAxis("/input/LookHorizontal", 0), 300);
            console.log("-> turn right pulse");
            break;
        case "say":
            say(arg);
            console.log(`-> chatbox: ${arg}`);
            break;
        case "raw": {
            const [addr, val] = rest;
            send(addr, { type: "f", value: parseFloat(val) });
            console.log(`-> raw ${addr} ${val}`);
            break;
        }
        case "q":
            process.exit(0);
            break;
        default:
            console.log("unknown command");
    }
});