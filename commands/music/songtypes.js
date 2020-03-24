// @ts-check

const Discord = require("discord.js")
/** @type {import("node-fetch").default} */
// @ts-ignore
const fetch = require("node-fetch")

const passthrough = require("../../passthrough")
const { constants, reloader, frisky, config, ipc } = passthrough

const utils = require("../../modules/utilities.js")
reloader.useSync("./modules/utilities.js", utils)

const common = require("./common.js")
reloader.useSync("./commands/music/common.js", common)

const stationData = new Map([
	["original", {
		title: "Frisky Radio: Original",
		queue: "Frisky Radio: Original",
		client_name: "frisky",
		url: "http://stream.friskyradio.com/frisky_mp3_hi", // 44100Hz 2ch 128k MP3
		beta_url: "http://stream.friskyradio.com/frisky_mp3_hi" // 44100Hz 2ch 128k MP3
	}],
	["deep", {
		title: "Frisky Radio: Deep",
		queue: "Frisky Radio: Deep",
		client_name: "deep",
		url: "http://deep.friskyradio.com/friskydeep_acchi", // 32000Hz 2ch 128k MP3 (!)
		beta_url: "http://deep.friskyradio.com/friskydeep_aachi" // 32000Hz 2ch 128k MP3 (!)
	}],
	["chill", {
		title: "Frisky Radio: Chill",
		queue: "Frisky Radio: Chill",
		client_name: "chill",
		url: "http://chill.friskyradio.com/friskychill_mp3_high", // 44100Hz 2ch 128k MP3
		beta_url: "https://stream.chill.friskyradio.com/mp3_high" // 44100Hz 2ch 128k MP3
	}],
	["classics", {
		title: "Frisky Radio: Classics",
		queue: "Frisky Radio: Classics",
		client_name: "classics",
		url: "https://stream.classics.friskyradio.com/mp3_high", // 44100Hz 2ch 128k MP3
		beta_url: "https://stream.classics.friskyradio.com/mp3_high" // 44100Hz 2ch 128k MP3
	}]
])

class Song {
	constructor() {
		this.title = ""
		this.queueLine = ""
		this.track = ""
		this.lengthSeconds = -1
		this.npUpdateFrequency = 0
		this.noPauseReason = ""
		this.error = ""
		this.typeWhileGetRelated = true
		this.id = ""
		this.live = null
		this.thumbnail = {
			src: "",
			width: 0,
			height: 0
		}
		/**
		 * might not be set!
		 * @type {import("./queue").Queue}
		 */
		this.queue = null

		this.validated = false
		setTimeout(() => {
			if (this.validated == false) this.validationError("must call validate() in constructor")
		})
	}
	/**
	 * @returns {any}
	 */
	toObject() {
		return {
			class: "Did not override generic toObject"
		}
	}
	getState() {
		return {
			title: this.title,
			length: this.lengthSeconds,
			thumbnail: this.thumbnail,
			live: this.live
		}
	}
	/**
	 * @param {number} time milliseconds
	 * @param {boolean} paused
	 */
	getProgress(time, paused) {
		return ""
	}
	/**
	 * An array of Song objects from related songs
	 * @returns {Promise<Song[]>}
	 */
	getRelated() {
		return Promise.resolve([])
	}
	/**
	 * Sendable data showing the related songs
	 * @returns {Promise<string|Discord.MessageEmbed>}
	 */
	showRelated() {
		return Promise.resolve("This isn't a real song.")
	}
	/**
	 * Get sendable data with information about this song
	 * @returns {Promise<string|Discord.MessageEmbed>}
	 */
	showInfo() {
		return Promise.resolve("This isn't a real song.")
	}
	/**
	 * @param {string} message
	 */
	validationError(message) {
		console.error(`Song validation error: ${this.constructor.name} ${message}`)
	}
	validate() {
		["id", "track", "title", "queueLine", "npUpdateFrequency"].forEach(key => {
			if (!this[key]) this.validationError(`unset ${key}`)
		})
		;["getProgress", "getRelated", "showRelated", "showInfo", "toObject", "destroy"].forEach(key => {
			if (this[key] === Song.prototype[key]) this.validationError(`unset ${key}`)
		})
		if (typeof (this.lengthSeconds) != "number" || this.lengthSeconds < 0) this.validationError("unset lengthSeconds")
		if (!this.thumbnail.src) this.validationError("unset thumbnail src")
		if (this.live === null) this.validationError("unset live")
		this.validated = true
	}
	/**
	 * Code to run to prepare the song for playback, such as fetching its `track`.
	 */
	prepare() {
		return Promise.resolve()
	}
	/**
	 * Code to run after the song was regenerated from resuming a queue
	 */
	resume() {
		return Promise.resolve()
	}
	/**
	 * Clean up event listeners and such when the song is removed
	 */
	destroy() {
		return undefined
	}
}

class YouTubeSong extends Song {
	/**
	 * @param {string} id
	 * @param {string} title
	 * @param {number} lengthSeconds
	 * @param {string} track
	 */
	constructor(id, title, lengthSeconds, track = null) {
		super()
		this.id = id
		this.thumbnail = {
			src: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
			width: 320,
			height: 180
		}
		this.title = title
		this.lengthSeconds = lengthSeconds
		/** @type {string} */ // the vscode type checker is dumb, it would seem
		this.track = track || "!"
		this.queueLine = `**${this.title}** (${common.prettySeconds(this.lengthSeconds)})`
		this.npUpdateFrequency = 5000
		this.typeWhileGetRelated = true
		this.live = false

		this.related = new utils.AsyncValueCache(
		/** @returns {Promise<any[]>} */
			() => {
				return fetch(`${this.getInvidiousOrigin()}/api/v1/videos/${this.id}`).then(async data => {
					const json = await data.json()
					this.typeWhileGetRelated = false
					return json.recommendedVideos.filter(v => v.lengthSeconds > 0).slice(0, 10)
				})
			})

		// eslint-disable-next-line require-await
		this.prepareCache = new utils.AsyncValueCache(async () => {
			if (this.track == "!") {
				if (config.use_invidious) { // Resolve track with Invidious
					let host = null
					let region = null
					if (this.queue) {
						host = this.queue.player.node.host
						region = this.queue.voiceChannel.guild.region
					}
					return common.invidious.getTrack(this.id, host, region).then(t => {
						this.track = t
					}).catch(error => {
						if (typeof error === "string") this.error = error
						else this.error = `${error.name} - ${error.message}`
					})
				} else { // Resolve track with Lavalink
					return common.getTracks(this.id, this.queue.textChannel.guild.region).then(tracks => {
						if (!tracks[0]) this.error = `No results for ID ${this.id}`
						else if (!tracks[0].track) this.error = `Missing track for ID ${this.id}`
						else this.track = tracks[0].track
					}).catch(message => {
						this.error = message
					})
				}
			}
		})

		this.validate()
	}
	toObject() {
		return {
			class: "YouTubeSong",
			id: this.id,
			title: this.title,
			lengthSeconds: this.lengthSeconds,
			track: this.track
		}
	}
	/**
	 * @param {number} time milliseconds
	 * @param {boolean} paused
	 */
	getProgress(time, paused) {
		const max = this.lengthSeconds
		const rightTime = common.prettySeconds(max)
		if (time > max) time = max
		const leftTime = common.prettySeconds(time)
		const bar = utils.progressBar(35, time, max, paused ? " [PAUSED] " : "")
		return `\`[ ${leftTime} ${bar} ${rightTime} ]\``
	}
	async getRelated() {
		const related = await this.related.get().catch(() => [])
		return related.map(v => new YouTubeSong(v.videoId, v.title, v.lengthSeconds))
	}
	showRelated() {
		return this.related.get().then(related => {
			if (related.length) {
				return new Discord.MessageEmbed()
					.setTitle("Related content from YouTube")
					.setDescription(
						related.map((v, i) =>
							`${i + 1}. **${Discord.Util.escapeMarkdown(v.title)}** (${common.prettySeconds(v.lengthSeconds)})`
						+ `\n — ${v.author}`
						)
					)
					.setFooter("Play one of these? &music related play <number>, or &m rel p <number>")
					.setColor(0x36393f)
			} else {
				return "No related content available for the current song."
			}
		}).catch(() => {
			this.typeWhileGetRelated = false
			return ""
				+ "Invidious didn't return valid data."
				+ `\n<${this.getInvidiousOrigin()}/api/v1/videos/${this.id}>`
				+ `\n<${this.getInvidiousOrigin()}/v/${this.id}>`
				+ `\n<https://youtu.be/${this.id}>`
		})
	}
	getInvidiousOrigin() {
		return common.invidious.getOrigin(this.queue && this.queue.player.node.host)
	}
	showInfo() {
		return Promise.resolve(`https://www.youtube.com/watch?v=${this.id}`)
	}
	prepare() {
		return this.prepareCache.get()
	}
	resume() {
		return Promise.resolve()
	}
	destroy() {
		return undefined
	}
}

class FriskySong extends Song {
	/**
	 * @param {string} station
	 * @param {any} [data]
	 */
	constructor(station, data = {}) {
		super()

		this.station = station

		if (!stationData.has(this.station)) throw new Error(`Unsupported station: ${this.station}`)
		this.stationData = stationData.get(this.station)

		this.id = this.station // designed for error reporting
		this.thumbnail = {
			src: constants.frisky_placeholder,
			width: 320,
			height: 180
		}
		this.title = this.stationData.title
		this.queueLine = `**${this.stationData.queue}** (LIVE)`
		this.track = data.track || "!"
		this.lengthSeconds = 0
		this.npUpdateFrequency = 15000
		this.typeWhileGetRelated = false
		this.noPauseReason = "You can't pause live radio."
		this.live = true

		this.friskyStation = frisky.managers.stream.stations.get(this.stationData.client_name)
		this.stationInfoGetter = new utils.AsyncValueCache(
			/**
			 * @returns {Promise<import("frisky-client/lib/Stream")>}
			 */
			() => new Promise((resolve, reject) => {
				let attempts = 0

				const attempt = () => {
					const retry = (reason) => {
						if (attempts < 5) {
							setTimeout(() => {
								attempt()
							}, 1000)
						} else {
							reject(reason)
						}
					}

					attempts++
					const index = this.friskyStation.findNowPlayingIndex()
					if (index == null) return retry("Current item is unknown")
					const stream = this.friskyStation.getSchedule()[index]
					if (!stream) return retry("Current stream not available")
					if (!stream.mix) return retry("Current mix not available")
					if (!stream.mix.data) return retry("Current mix data not available")
					const episode = stream.mix.episode
					if (!episode) return retry("Current episode not available")
					if (!episode.data) return retry("Current episode data not available")
					// console.log("Retrieved Frisky station data in "+(Date.now()-time)+"ms")
					return resolve(stream)
				}
				attempt()
			})
		)

		this._filledBarOffset = 0

		this.validate()
	}
	toObject() {
		return {
			class: "FriskySong",
			station: this.station,
			track: this.track
		}
	}
	getRelated() {
		return Promise.resolve([])
	}
	showRelated() {
		return Promise.resolve("Try the other stations on Frisky Radio! `&frisky`, `&frisky deep`, `&frisky chill`")
	}
	showInfo() {
		return this.stationInfoGetter.get().then(stream => {
			const mix = stream.mix
			const stationCase = this.station[0].toUpperCase() + this.station.slice(1).toLowerCase()
			let percentPassed = Math.floor(((-stream.getTimeUntil()) / (stream.data.duration * 1000)) * 100)
			if (percentPassed < 0) percentPassed = 0
			if (percentPassed > 100) percentPassed = 100
			const embed = new Discord.MessageEmbed()
				.setColor(0x36393f)
				.setTitle(`FRISKY: ${mix.data.title}`)
				.setURL(`https://beta.frisky.fm/mix/${mix.id}`)
				.addFields({
					name: "Details",
					value: utils.tableifyRows(
						[
							["Episode", `${mix.data.title} / [view](https://beta.frisky.fm/mix/${mix.id})`],
							["Show", `${mix.data.title.split(" - ")[0]} / [view](https://beta.frisky.fm/shows/${mix.data.show_id.id})`],
							["Genre", mix.data.genre.join(", ")],
							["Station", stationCase],
							["Schedule", `started ${utils.shortTime(-stream.getTimeUntil(), "ms", ["d", "h", "m"])} ago, ${utils.shortTime(stream.getTimeUntil() + stream.data.duration * 1000, "ms", ["d", "h", "m"])} remaining (${percentPassed}%)`]
						],
						["left", ""],
						() => "`"
					)
				})
			if (mix.episode) {
				embed.setThumbnail(this.thumbnail.src)
			}
			if (mix.data.track_list && mix.data.track_list.length) {
				let trackList = mix.data.track_list
					.slice(0, 6)
					.map(track => `${track.artist} - ${track.title}`)
					.join("\n")
				const hidden = mix.data.track_list.length - 6
				if (hidden > 0) trackList += `\n_and ${hidden} more..._`
				embed.addFields({ name: "Track list", value: trackList })
			}
			return embed
		}).catch(reason => {
			console.error(reason)
			return "Unfortunately, we failed to retrieve information about the current song."
		})
	}
	getProgress(time, paused) {
		const part = "= ⋄ ==== ⋄ ==="
		const fragment = part.substr(7 - this._filledBarOffset, 7)
		const bar = `${fragment.repeat(5)}` // SC: ZWSP x 2
		this._filledBarOffset++
		if (this._filledBarOffset >= 7) this._filledBarOffset = 0
		time = common.prettySeconds(time)
		// eslint-disable-next-line no-irregular-whitespace
		return `\`[ ${time} ​${bar}​ LIVE ]\`` // SC: ZWSP x 2
	}
	async prepare() {
		if (!this.bound) {
			this.bound = this.stationUpdate.bind(this)
			this.friskyStation.events.addListener("changed", this.bound)
			await this.stationUpdate()
		}
		if (this.track == "!") {
			return common.getTracks(this.stationData.beta_url, this.queue.textChannel.guild.region).then(tracks => {
				if (tracks[0] && tracks[0].track) this.track = tracks[0].track
				else {
					console.error(tracks)
					this.error = `No tracks available for station ${this.station}`
				}
			}).catch(message => {
				this.error = message
			})
		} else return Promise.resolve()
	}
	stationUpdate() {
		this.stationInfoGetter.clear()
		return this.stationInfoGetter.get().then(stream => {
			const mix = stream.mix
			// console.log(mix)
			this.title = mix.data.title
			this.thumbnail.src = mix.episode.data.album_art.url
			this.thumbnail.width = mix.episode.data.album_art.image_width
			this.thumbnail.height = mix.episode.data.album_art.image_height
			if (this.queue) {
				const index = this.queue.songs.indexOf(this)
				if (index !== -1) ipc.replier.sendSongUpdate(this.queue, this, index)
			}
		}).catch(reason => {
			console.error(reason)
		})
	}
	resume() {
		return this.prepare()
	}
	destroy() {
		if (this.bound) this.friskyStation.events.removeListener("changed", this.bound)
	}
}

function makeYouTubeSongFromData(data) {
	if (config.use_invidious) return new YouTubeSong(data.info.identifier, data.info.title, Math.ceil(data.info.length / 1000))
	else return new YouTubeSong(data.info.identifier, data.info.title, Math.ceil(data.info.length / 1000), data.track)
}

module.exports.makeYouTubeSongFromData = makeYouTubeSongFromData
module.exports.Song = Song
module.exports.YouTubeSong = YouTubeSong
module.exports.FriskySong = FriskySong
