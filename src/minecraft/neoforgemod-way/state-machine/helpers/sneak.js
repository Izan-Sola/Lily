export class SneakHelper {
  // Controls the player's sneaking state and timing.
  constructor(mcSend) {
    this.mcSend = mcSend;
    this.isSneaking = false;
    this._holdTimer = null;
  }

  // Sets the current sneaking state. If it changes, sends a 'sneak' event to Minecraft and logs it.
  setSneaking(value) {
    if (this.isSneaking === value) return;
    this.isSneaking = value;
    this.mcSend('sneak', { value });
    console.log(`[SNEAK] ${value ? 'ON' : 'OFF'}`);
  }

  // Creates a temporary pulse: sets sneaking off briefly then on again after a delay.
  pulse(ms = 100) {
    this.cancelHold();
    this.setSneaking(false);
    setTimeout(() => {
      this.setSneaking(true);
      this._holdTimer = setTimeout(() => {
        this.setSneaking(false);
        this._holdTimer = null;
      }, ms);
    }, 50);
  }

  // Holds the sneak state for a given duration before turning it off.
  hold(ms = 0) {
    this.cancelHold();
    this.setSneaking(false);
    setTimeout(() => {
      this.setSneaking(true);
      if (ms > 0) {
        this._holdTimer = setTimeout(() => {
          this.setSneaking(false);
          this._holdTimer = null;
        }, ms);
      }
    }, 50);
  }

  // Cancels any running hold timer to prevent conflicts or memory leaks.
  cancelHold() {
    if (this._holdTimer) {
      clearTimeout(this._holdTimer);
      this._holdTimer = null;
    }
  }
}