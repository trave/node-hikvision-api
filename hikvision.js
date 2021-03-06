const net = require('net');
const events = require('events');
const util = require('util');
const request = require('request');
const NetKeepAlive = require('net-keepalive');
const xml2js = require('xml2js');


// hikvision HTTP API Module
class HikvisionAPI extends events.EventEmitter {
	constructor(options) {
		super();

		this.client = this.connect(options);
		this._log = !!options.log;
		this._baseUrl = `http://${options.host}:${options.port}`;
		this._parser = new xml2js.Parser();
		this._user = options.user;
		this._password = options.pass;
		this._host = options.host;
		this.activeEvents = {};
		this.triggerActive = false;

		this.POINT = {
			PTZ: '/cgi-bin/ptz.cgi',
			CONFIG_MANAGER: '/cgi-bin/configManager.cgi',
			MAIN_CHANNEL: '/ISAPI/Streaming/channels/101',
			SECOND_CHANNEL: '/ISAPI/Streaming/channels/102'
		};
	}

	getMainChannelInfo() {
		return this.request(this.POINT.MAIN_CHANNEL)
			.then((data) => {
				return this.xml2object(data.toString());
			});
	}

	getSecondChannelInfo() {
		return this.request(this.POINT.MAIN_CHANNEL)
			.then((data) => {
				return this.xml2object(data.toString());
			});
	}

	getMainChannelRtspUrl() {
		return `rtsp://${this._user}:${this._password}@${this._host}/Streaming/Channels/1`;
	}

	getSecondChannelRtspUrl() {
		return `rtsp://${this._user}:${this._password}@${this._host}/Streaming/Channels/2`;
	}

	snapPicture() {
		return this.request('/Streaming/channels/1/picture', {
			encoding: 'binary'
		});
	}

	snapPicture2() {
		return this.request('/Streaming/channels/2/picture', {
			encoding: 'binary'
		});
	}

	// Attach to camera
	connect(options) {
		const authHeader = `Authorization: Basic ${new Buffer(options.user + ':' + options.pass).toString('base64')}`;
		// Connect
		const client = net.connect(options, () => {
			const header = `GET /ISAPI/Event/notification/alertStream HTTP/1.1\r\nHost: ${options.host}:${options.port}\r\n${authHeader}\r\nAccept: multipart/x-mixed-replace\r\n\r\n`;
			client.write(header);
			client.setKeepAlive(true, 1000);
			// sets TCP_KEEPINTVL to 5s
			NetKeepAlive.setKeepAliveInterval(client, 5000);
			// 60s and kill the connection.
			NetKeepAlive.setKeepAliveProbes(client, 12);

			this.log(`Connected to ${options.host}:${options.port}`);
			// this.socket = socket;
			this.emit('connect');
		});

		client.on('data', (data) => {
			this.handleData(data);
		});

		client.on('close', () => {
			// Try to reconnect after 30s
			setTimeout(() => {
				this.connect(options);
			}, 30000);
			this.log('Connection closed!');
			this.emit('end');
		});

		client.on('error', (err) => {
			this.handleError(err);
		});

		return client;
	}

	// Raw PTZ Command - command/arg1/arg2/arg3/arg4
	ptzCommand(cmd, arg1, arg2, arg3, arg4) {
		if ((!cmd) || (isNaN(arg1)) || (isNaN(arg2)) || (isNaN(arg3)) || (isNaN(arg4))) {
			this.handleError('INVALID PTZ COMMAND')
			return 0;
		}
		return this.request(this.POINT.PTZ, {}, {
				action: 'start',
				channel: 0,
				code: cmd,
				arg1: arg1,
				arg2: arg2,
				arg3: arg3,
				arg4: arg4
			})
			.then((responseBody) => {
				if (responseBody.toString().trim() !== 'OK') {
					throw new Error(responseBody);
				}
			})
			.catch((err) => {
				this.handleError(err, 'FAILED TO ISSUE PTZ COMMAND');
			});
	}

	// PTZ Preset - number
	ptzPreset(preset) {
		if (isNaN(preset)) {
			this.handleError('INVALID PTZ PRESET');
		}

		return this.ptzCommand('GotoPreset', 0, preset, 0, 0);
	}

	// PTZ Zoom - multiplier
	ptzZoom(multiple) {
		if (isNaN(multiple)) {
			this.handleError('INVALID PTZ ZOOM');
		}
		if (multiple > 0) {
			cmd = 'ZoomTele';
		}
		if (multiple < 0) {
			cmd = 'ZoomWide';
		}
		if (multiple === 0) {
			return 0;
		}

		return this.ptzCommand(cmd, 0, multiple, 0, 0);
	}

	// PTZ Move - direction/action/speed
	ptzMove(direction, action, speed) {
		if (isNaN(speed)) {
			this.handleError('INVALID PTZ SPEED');
		}
		if ((action !== 'start') || (action !== 'stop')) {
			const err = 'INVALID PTZ COMMAND';
			this.handleError(err);
			return Promise.reject(err);
		}
		const availableDirections = [
			'Up','Down','Left','Right',
			'LeftUp','RightUp','LeftDown','RightDown'
		];
		if (!availableDirections.contains(direction)) {
			this.handleError(err, `INVALID PTZ DIRECTION: ${direction}`);
			return Promise.reject(err);
		}

		return this.ptzCommand(direction, speed, speed, 0, 0);
	}

	// Request PTZ Status
	ptzStatus() {
		this.request(this.POINT.PTZ, {}, {action: 'getStatus'})
			.then((body) => {
				body = body.toString().split('\r\n').trim()
				this.log(`PTZ STATUS: ${body}`);
				this.emit('ptzStatus', body);
			})
			.catch((err) => {
				this.handleError(err, 'FAILED TO QUERY STATUS');
			});
	}

	// Switch to Day Profile
	dayProfile() {
		this.request(this.POINT.CONFIG_MANAGER, {}, {
				action: 'setConfig',
				'VideoInMode[0].Config[0]': 1
			})
			.then((responseBody) => {
				// Didnt work, lets try another method for older cameras
				if (responseBody.toString() === 'Error') {
					return this.request(this.POINT.CONFIG_MANAGER, {}, {
						action: 'setConfig',
						'VideoInOptions[0].NightOptions.SwitchMode': 0
					});
				}
			})
			.catch((err) => {
				this.handleError(err, 'FAILED TO CHANGE TO DAY PROFILE');
			});
	}

	// Switch to Night Profile
	nightProfile() {
		this.request(this.POINT.CONFIG_MANAGER, {}, {
				action: 'setConfig',
				'VideoInMode[0].Config[0]': 2
			})
			.then((responseBody) => {
				// Didnt work, lets try another method for older cameras
				if (responseBody.toString() === 'Error') {
					return this.request(this.POINT.CONFIG_MANAGER, {}, {
						action: 'setConfig',
						'VideoInOptions[0].NightOptions.SwitchMode': 3
					});
				}
			})
			.catch((err) => {
				this.handleError(err, 'FAILED TO CHANGE TO NIGHT PROFILE');
			});
	}

	handleError(err, humanMessage) {
		this.log('Error:', err);
		this.emit('error', humanMessage || err);
	}

	// Handle alarms
	handleData(data) {
		this.xml2object(data)
			.then((result) => {
				let code = result['EventNotificationAlert']['eventType'][0];
				let action = result['EventNotificationAlert']['eventState'][0];
				const index = parseInt(result['EventNotificationAlert']['channelID'][0]);
				const count = parseInt(result['EventNotificationAlert']['activePostCount'][0]);

				// give codes returned by camera prettier and standardized description
				code = {
						'IO': 'AlarmLocal',
						'VMD': 'VideoMotion',
						'linedetection': 'LineDetection',
						'videoloss': 'VideoLoss',
						'shelteralarm': 'VideoBlind'
					}[code] || code;

				action = {
						'active': 'Start',
						'inactive': 'Stop'
					}[action] || action;

				// create and event identifier for each recieved event
				// This allows multiple detection types with multiple indexes for DVR or multihead devices
				const eventIdentifier = code + index;

				// Count 0 seems to indicate everything is fine and nothing is wrong, used as a heartbeat
				// if triggerActive is true, lets step through the activeEvents
				// If activeEvents has something, lets end those events and clear activeEvents and reset triggerActive
				if (count == 0) {
					if (this.triggerActive == true) {
						for (var i in this.activeEvents) {
							if (this.activeEvents.hasOwnProperty(i)) {
								var eventDetails = this.activeEvents[i]
								this.log(`Ending Event: ${i} - ${eventDetails['code']} - ${(Date.now() - eventDetails['lasttimestamp']) / 1000}`);
								this.emit('alarm', eventDetails['code'], 'Stop', eventDetails['index']);
							}
						}
						this.activeEvents = {};
						this.triggerActive = false;

					} else {
						// should be the most common result
						// Nothing interesting happening and we haven't seen any events
						this.log('alarm', code, action, index);
					}
				}

				// if the first instance of an eventIdentifier, lets emit it,
				// add to activeEvents and set triggerActive
				else if (typeof this.activeEvents[eventIdentifier] == 'undefined' || this.activeEvents[eventIdentifier] == null) {
					var eventDetails = {};
					eventDetails['code'] = code;
					eventDetails['index'] = index;
					eventDetails['lasttimestamp'] = Date.now();

					this.activeEvents[eventIdentifier] = eventDetails;
					this.emit('alarm', code, action, index);
					this.triggerActive = true;

					// known active events
				} else {
					this.log(`    Skipped Event: ${code} ${action} ${index} ${count}`);

					// Update lasttimestamp
					var eventDetails = {};
					eventDetails['code'] = code;
					eventDetails['index'] = index;
					eventDetails['lasttimestamp'] = Date.now();
					this.activeEvents[eventIdentifier] = eventDetails;

					// step through activeEvents
					// if we haven't seen it in more than 2 seconds, lets end it and remove from activeEvents
					for (var i in this.activeEvents) {
						if (this.activeEvents.hasOwnProperty(i)) {
							var eventDetails = this.activeEvents[i];
							if (((Date.now() - eventDetails['lasttimestamp']) / 1000) > 2) {
								this.log(`    Ending Event: ${i} - ${eventDetails['code']} - ${(Date.now() - eventDetails['lasttimestamp']) / 1000}`);
								this.emit('alarm', eventDetails['code'], 'Stop', eventDetails['index']);
								delete this.activeEvents[i];
							}
						}
					}
				}
			}, () => { /* ignore XML parsing errors */ });
	}

	request(point, options = {}, data = {}) {
		const params = Object.keys(data)
			.map((k) => [k, data[k]]) // Object.entries
			.map((pair) => `${pair[0]}=${encodeURIComponent(pair[1])}`)
			.join('&');

		const url = `${this._baseUrl}${point}${params?'?':''}${params}`;
		this.log(`Getting ${url}`);

		return new Promise((resolve, reject) => {
			request(
				url,
				Object.assign({
					headers: {
						'Authorization': `Basic ${new Buffer(this._user + ':' + this._password).toString('base64')}`
					}
				}, options),
				(error, response, body) => {
					if ((!error) && (response.statusCode === 200)) {
						resolve(body);
					} else {
						reject(error || new Error(`Status: ${response.statusCode} in ${url}`));
					}
				});
		});
	}

	log(...args) {
		if (this._log) {
			console.log(...args);
		}
	}

	xml2object(xmlString) {
		return new Promise((resolve, reject) => {
			this._parser.parseString(xmlString, (err, result) => {
				if (err || !result) {
					reject(err || result);
				} else {
					resolve(result);
				}
			});
		});
	}
}


module.exports = HikvisionAPI;
