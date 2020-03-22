// @ts-check

const Discord = require("discord.js")
const { EventEmitter } = require("events")

const passthrough = require("../../../passthrough")
const { client, reloader, ipc } = passthrough

const QueueFile = require("../../../commands/music/queue")
reloader.useSync("./commands/music/queue.js", QueueFile)

const utils = require("../../utilities")
reloader.useSync("./modules/utilities.js", utils)

class QueueStore {
	constructor() {
		/** @type {Discord.Collection<string, QueueFile.Queue>} */
		this.store = new Discord.Collection()
		this.songsPlayed = 0
		this.events = new EventEmitter()
	}
	toObject() {
		return {
			_id: "QueueStore_" + utils.getFirstShard(),
			queues: [...this.store.values()].map(q => q.toObject())
		}
	}
	/**
	 * @param {string} guildID
	 */
	has(guildID) {
		return this.store.has(guildID)
	}
	get(guildID) {
		return this.store.get(guildID)
	}
	/**
	 * @param {Discord.VoiceChannel} voiceChannel
	 * @param {Discord.TextChannel} textChannel
	 */
	getOrCreate(voiceChannel, textChannel) {
		const guildID = voiceChannel.guild.id
		if (this.store.has(guildID)) return this.store.get(guildID)
		else return this.create(voiceChannel, textChannel)
	}
	/**
	 * @param {Discord.VoiceChannel} voiceChannel
	 * @param {Discord.TextChannel} textChannel
	 */
	create(voiceChannel, textChannel) {
		const guildID = voiceChannel.guild.id
		const instance = new QueueFile.Queue(this, voiceChannel, textChannel)
		this.store.set(guildID, instance)
		ipc.replier.sendNewQueue(instance)
		this.events.emit("create", instance)
		return instance
	}
	/**
	 * Remove a queue from the store
	 * @param {string} guildID
	 */
	delete(guildID) {
		this.store.delete(guildID)
		ipc.replier.sendDeleteQueue(guildID)
		this.events.emit("delete", guildID)
	}
	save() {
		return passthrough.nedb.queue.update({ _id: "QueueStore_" + utils.getFirstShard() }, this.toObject(), { upsert: true })
	}
	async restore() {
		const songTypes = require("../../../commands/music/songtypes")
		const data = await passthrough.nedb.queue.findOne({ _id: "QueueStore_" + utils.getFirstShard() })
		data.queues.forEach(async q => {
			// console.log(q)
			const guildID = q.guildID
			const voiceChannel = client.channels.cache.get(q.voiceChannelID)
			const textChannel = client.channels.cache.get(q.textChannelID)
			if (!(voiceChannel instanceof Discord.VoiceChannel) || !(textChannel instanceof Discord.TextChannel)) throw new Error("The IDs you saved don't match to channels, dummy")
			console.log("Making queue for voice channel " + voiceChannel.name)
			const exists = this.has(guildID)
			if (exists) console.log("Queue already in store! Skipping.")
			else {
				const queue = this.getOrCreate(voiceChannel, textChannel)
				q.songs.forEach(s => {
					if (s.class == "YouTubeSong") {
						const song = new songTypes.YouTubeSong(s.id, s.title, s.lengthSeconds, s.track)
						queue.songs.push(song)
						console.log("Added YouTubeSong " + song.title)
					} else if (s.class == "FriskySong") {
						const song = new songTypes.FriskySong(s.station, { track: s.track })
						queue.songs.push(song)
						console.log("Added FriskySong " + song.station)
					}
				})
				queue.songs[0].resume()
				queue.songStartTime = q.songStartTime
				queue.pausedAt = q.pausedAt
				const message = await textChannel.messages.fetch(q.npID, false)
				// eslint-disable-next-line require-atomic-updates
				queue.np = message
				queue._startNPUpdates()
				queue._makeReactionMenu()
				ipc.replier.sendNewQueue(queue)
			}
		})
		setTimeout(() => passthrough.nedb.queue.update({ _id: "QueueStore_" + utils.getFirstShard() }, { _id: "QueueStore_" + utils.getFirstShard(), queues: [] }, { upsert: true }), 1000 * 60 * 2)
	}
}

module.exports = QueueStore
