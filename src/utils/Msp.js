class MSP {
  constructor(serial, serialWriter, serialReader) {
    this.serial = serial;
    this.serialWriter = serialWriter;
    this.serialReader = serialReader;

    this.packetError = 0;
    this.lastReceivedTimestamp = null;

    this.unsupported = 0;

    this.messageDirection = 1; // ????
    this.analogLastReceivedTimestamp = null; // ????
  }

  read(data) {
    let code = 0;
    let state = 0;
    let messageBuffer = null;
    let messageChecksum = null;
    let messageLengthExpected = 0;
    let messageLengthReceived = 0;
    let messageBufferUint8View = null;

    for (let i = 0; i < data.length; i += 1) {
      switch (state) {

        // Sync char 1
        case 0: {
          if (data[i] === 36) { // $
            state += 1;
          }
        } break;

        // Sync char 2
        case 1: {
          if (data[i] === 77) { // M
            state += 1;
          } else {
          // Restart and try again
            state = 0;
          }
        } break;

        // Direction (should be >)
        case 2: {
          this.unsupported = 0;
          if (data[i] === 62) { // >
            this.messageDirection = 1;
          } else if (data[i] === 60) { // <
            this.messageDirection = 0;
          } else if (data[i] === 33) { // !
            // FC reports unsupported message error
            this.unsupported = 1;
          }

          state += 1;
        } break;

        case 3: {
          messageLengthExpected = data[i];

          messageChecksum = data[i];

          // Setup arraybuffer
          messageBuffer = new ArrayBuffer(messageLengthExpected);
          messageBufferUint8View = new Uint8Array(messageBuffer);

          state += 1;
        } break;

        case 4: {
          code = data[i];
          messageChecksum ^= data[i];

          // Process payload
          if (messageLengthExpected > 0) {
            state += 1;
          } else {
            // No payload
            state += 2;
          }
        } break;

        // Payload
        case 5: {
          messageBufferUint8View[messageLengthReceived] = data[i];
          messageChecksum ^= data[i];
          messageLengthReceived += 1;

          if (messageLengthReceived >= messageLengthExpected) {
            state += 1;
          }
        } break;

        case 6: {
          // Message received, process
          if (messageChecksum === data[i]) {
            const response = this.processData(
              code,
              messageBuffer,
              messageLengthExpected
            );

            this.lastReceivedTimestamp = Date.now();

            return response;
          }
          console.log(`code: ${code} - crc failed`);

          this.packetError += 1;

          // TODO: Needs callback for packet Error
        } break;

        default: {
          console.log(`Unknown state detected: ${state}`);
        }
      }
    }

    this.lastReceivedTimestamp = Date.now();

    return null;
  }

  async send(code, data) {
    let bufferOut;
    let bufView;

    // Always reserve 6 bytes for protocol overhead !
    if (data) {
      const size = data.length + 6;
      let checksum = 0;

      bufferOut = new ArrayBuffer(size);
      bufView = new Uint8Array(bufferOut);

      bufView[0] = 36; // $
      bufView[1] = 77; // M
      bufView[2] = 60; // <
      bufView[3] = data.length;
      bufView[4] = code;

      checksum = bufView[3] ^ bufView[4];

      for (let i = 0; i < data.length; i += 1) {
        bufView[i + 5] = data[i];
        checksum ^= bufView[i + 5];
      }

      bufView[5 + data.length] = checksum;
    } else {
      bufferOut = new ArrayBuffer(6);
      bufView = new Uint8Array(bufferOut);

      bufView[0] = 36; // $
      bufView[1] = 77; // M
      bufView[2] = 60; // <
      bufView[3] = 0; // Data length
      bufView[4] = code; // Code
      bufView[5] = bufView[3] ^ bufView[4]; // Checksum
    }

    /*
    const writer = this.serial.writable.getWriter();
    await writer.write(bufferOut);
    await writer.releaseLock();
    */
    await this.serialWriter(bufferOut);

    let valueTotal = [];
    valueTotal = await this.serialReader();
    /*
    if (this.serial.readable) {
      const reader = await this.serial.readable.getReader();
      const forever = true;
      while (forever) {
        const { value } = await reader.read();

        if (value) {
          valueTotal = value;

          reader.releaseLock();
          break;
        }
      }
    }
    */

    return this.read(valueTotal);
  }

  getApiVersion() {
    return this.send(MSP.MSP_API_VERSION);
  }

  getFcVariant() {
    return this.send(MSP.MSP_FC_VARIANT);
  }

  getFcVersion() {
    return this.send(MSP.MSP_FC_VERSION);
  }

  getBuildInfo() {
    return this.send(MSP.MSP_BUILD_INFO);
  }

  getBoardInfo() {
    return this.send(MSP.MSP_BOARD_INFO);
  }

  getUid() {
    return this.send(MSP.MSP_UID);
  }

  set4WayIf() {
    return this.send(MSP.MSP_SET_4WAY_IF);
  }

  processData(code, messageBuffer, messageLength) {
    // DataView (allowing us to view arrayBuffer as struct/union)
    const data = new DataView(
      messageBuffer,
      0
    );
    const config = {};
    const escConfig = {};
    const motorData = [];

    if (!this.unsupported) {
      switch (code) {
        case MSP.MSP_IDENT: {
          console.log('Using deprecated msp command: MSP_IDENT');

          // Deprecated
          config.version = parseFloat((data.getUint8(0) / 100).toFixed(2));
          config.multiType = data.getUint8(1);
          config.msp_version = data.getUint8(2);
          config.capability = data.getUint32(3, 1);

          return config;
        }

        case MSP.MSP_STATUS: {
          config.cycleTime = data.getUint16(0, 1);
          config.i2cError = data.getUint16(2, 1);
          config.activeSensors = data.getUint16(4, 1);
          config.mode = data.getUint32(6, 1);
          config.profile = data.getUint8(10);

          return config;
        }

        case MSP.MSP_MOTOR: {
          const motorCount = messageLength / 2;
          let needle = 0;
          for (let i = 0; i < motorCount; i += 1) {
            motorData[i] = data.getUint16(needle, 1);

            needle += 2;
          }

          return motorData;
        }

        case MSP.MSP_SET_4WAY_IF: {
          escConfig.connectedESCs = data.getUint8(0);

          return escConfig;
        }

        case MSP.MSP_SET_MOTOR: {
          console.log('Motor Speeds Updated');
        } break;

        // Additional baseflight commands that are not compatible with MultiWii
        case MSP.MSP_UID: {
          config.uid = [];
          config.uid[0] = data.getUint32(0, 1);
          config.uid[1] = data.getUint32(4, 1);
          config.uid[2] = data.getUint32(8, 1);

          return config;
        }

        /*
       *
       * Cleanflight specific
       *
       */
        case MSP.MSP_API_VERSION: {
          let offset = 0;
          config.mspProtocolVersion = data.getUint8(offset++);
          config.apiVersion = `${data.getUint8(offset++)}.`;
          config.apiVersion += `${data.getUint8(offset++)}.0`;

          return config;
        }

        case MSP.MSP_FC_VARIANT: {
          let identifier = '';
          for (let i = 0; i < 4; i += 1) {
            identifier += String.fromCharCode(data.getUint8(i));
          }

          config.flightControllerIdentifier = identifier;

          return config;
        }

        case MSP.MSP_FC_VERSION: {
          let offset = 0;
          config.flightControllerVersion = `${data.getUint8(offset++)}.`;
          config.flightControllerVersion += `${data.getUint8(offset++)}.`;
          config.flightControllerVersion += data.getUint8(offset++);

          return config;
        }

        case MSP.MSP_BUILD_INFO: {
          let offset = 0;
          const dateLength = 11;
          const buff = [];

          for (let i = 0; i < dateLength; i += 1) {
            buff.push(data.getUint8(offset++));
          }
          buff.push(32); // Ascii space

          const timeLength = 8;
          for (let i = 0; i < timeLength; i += 1) {
            buff.push(data.getUint8(offset++));
          }

          config.buildInfo = String.fromCharCode.apply(
            null,
            buff
          );

          return config;
        }

        case MSP.MSP_BOARD_INFO: {
          let identifier = '';
          let offset = 0;
          for (offset = 0; offset < 4; offset += 1) {
            identifier += String.fromCharCode(data.getUint8(offset));
          }

          config.boardIdentifier = identifier;
          config.boardVersion = data.getUint16(
            offset,
            1
          );
          // Offset += 2; // ???

          return config;
        }

        case MSP.MSP_SET_3D: {
          console.log('3D settings saved');
        } break;

        default: {
          console.log(
            'Unknown code detected:',
            code
          );
        }
      }
    } else if (code === MSP.MSP_SET_4WAY_IF) {

      /*
       * GUI.log(chrome.i18n.getMessage('blheliPassthroughNotSupported'));
       * TODO: log callback
       */
    } else {
      console.log(
        'FC reports unsupported message error:',
        code
      );
    }

    return null;
  }
}

MSP.MSP_API_VERSION = 1;
MSP.MSP_FC_VARIANT = 2;
MSP.MSP_FC_VERSION = 3;
MSP.MSP_BOARD_INFO = 4;
MSP.MSP_BUILD_INFO = 5;

// Multiwii MSP commands
MSP.MSP_IDENT = 100;
MSP.MSP_STATUS = 101;
MSP.MSP_MOTOR = 104;
MSP.MSP_3D = 124;
MSP.MSP_SET_3D = 217;

MSP.MSP_SET_4WAY_IF = 245;

// Additional baseflight commands that are not compatible with MultiWii
MSP.MSP_UID = 160; // Unique device ID

export default MSP;
