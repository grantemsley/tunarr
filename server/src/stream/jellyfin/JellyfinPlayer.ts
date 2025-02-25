import constants from '@tunarr/shared/constants';
import EventEmitter from 'events';
import { isNil, isNull, isUndefined } from 'lodash-es';
import { Writable } from 'stream';
import { isContentBackedLineupIteam } from '../../dao/derived_types/StreamLineup.js';
import {
  MediaSource,
  MediaSourceType,
} from '../../dao/entities/MediaSource.js';
import { ProgramDB } from '../../dao/programDB.js';
import { FFMPEG, FfmpegEvents } from '../../ffmpeg/ffmpeg.js';
import { TypedEventEmitter } from '../../types/eventEmitter.js';
import { Maybe, Nullable } from '../../types/util.js';
import { ifDefined, isDefined } from '../../util/index.js';
import { LoggerFactory } from '../../util/logging/LoggerFactory.js';
import { Player, PlayerContext } from '../Player.js';
import { JellyfinStreamDetails } from './JellyfinStreamDetails.js';
import { UpdateJellyfinPlayStatusScheduledTask } from '../../tasks/jellyfin/UpdateJellyfinPlayStatusTask.js';
import { GlobalScheduler } from '../../services/scheduler.js';

export class JellyfinPlayer extends Player {
  private logger = LoggerFactory.child({
    caller: import.meta,
    className: JellyfinPlayer.name,
  });
  private ffmpeg: Nullable<FFMPEG> = null;
  private killed: boolean = false;
  private updatePlayStatusTask: Maybe<UpdateJellyfinPlayStatusScheduledTask>;

  constructor(private context: PlayerContext) {
    super();
  }

  cleanUp() {
    super.cleanUp();
    this.killed = true;
    ifDefined(this.updatePlayStatusTask, (task) => {
      task.stop();
    });

    if (!isNull(this.ffmpeg)) {
      this.ffmpeg.kill();
      this.ffmpeg = null;
    }
  }

  async play(
    outStream: Writable,
  ): Promise<TypedEventEmitter<FfmpegEvents> | undefined> {
    const lineupItem = this.context.lineupItem;
    if (!isContentBackedLineupIteam(lineupItem)) {
      throw new Error(
        'Lineup item is not backed by Plex: ' + JSON.stringify(lineupItem),
      );
    }

    const ffmpegSettings = this.context.ffmpegSettings;
    const db = this.context.entityManager.repo(MediaSource);
    const channel = this.context.channel;
    const server = await db.findOne({
      type: MediaSourceType.Jellyfin,
      name: lineupItem.externalSourceId,
    });

    if (isNil(server)) {
      throw new Error(
        `Unable to find server "${lineupItem.externalSourceId}" specified by program.`,
      );
    }

    // const plexSettings = this.context.settings.plexSettings();
    const jellyfinStreamDetails = new JellyfinStreamDetails(
      server,
      this.context.settings,
      new ProgramDB(),
    );

    const watermark = this.context.watermark;
    this.ffmpeg = new FFMPEG(ffmpegSettings, channel); // Set the transcoder options
    this.ffmpeg.setAudioOnly(this.context.audioOnly);

    let streamDuration: number | undefined;

    if (
      !isUndefined(lineupItem.streamDuration) &&
      (lineupItem.start ?? 0) + lineupItem.streamDuration + constants.SLACK <
        lineupItem.duration
    ) {
      streamDuration = lineupItem.streamDuration / 1000;
    }

    const stream = await jellyfinStreamDetails.getStream(lineupItem);
    if (isNull(stream)) {
      this.logger.error('Unable to retrieve stream details from Jellyfin');
      return;
    }

    if (this.killed) {
      this.logger.warn('Stream was killed already, returning');
      return;
    }

    if (isDefined(stream.streamDetails)) {
      stream.streamDetails.duration = lineupItem.streamDuration;
    }

    const emitter = new EventEmitter() as TypedEventEmitter<FfmpegEvents>;
    let ffmpegOutStream = this.ffmpeg.spawnStream(
      stream.streamUrl,
      stream.streamDetails,
      // Don't use FFMPEG's -ss parameter for Jellyfin since we need to request
      // the seek against their API instead
      (lineupItem.start ?? 0) / 1000,
      streamDuration?.toString(),
      watermark,
      {
        // TODO: Use the real authorization string
        'X-Emby-Token': server.accessToken,
      },
    ); // Spawn the ffmpeg process

    if (isUndefined(ffmpegOutStream)) {
      throw new Error('Unable to spawn ffmpeg');
    }

    ffmpegOutStream.pipe(outStream, { end: false });

    // TODO: Generalize media source settings
    if (this.context.settings.plexSettings().updatePlayStatus) {
      this.updatePlayStatusTask = new UpdateJellyfinPlayStatusScheduledTask(
        server,
        {
          first: true,
          channelNumber: channel.number,
          itemDuration: lineupItem.duration,
          itemId: lineupItem.externalKey,
          itemStartPositionMs: lineupItem.start ?? 0,
        },
      );

      GlobalScheduler.scheduleTask(
        this.updatePlayStatusTask.id,
        this.updatePlayStatusTask,
      );
    }

    this.ffmpeg.on('end', () => {
      emitter.emit('end');
    });

    this.ffmpeg.on('close', () => {
      emitter.emit('close');
    });

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.ffmpeg.on('error', (err) => {
      this.logger.debug('Replacing failed stream with error stream');
      ffmpegOutStream!.unpipe(outStream);
      this.ffmpeg?.removeAllListeners();
      // TODO: Extremely weird logic here leftover, should sort this all out.
      this.ffmpeg = new FFMPEG(ffmpegSettings, channel); // Set the transcoder options
      this.ffmpeg.setAudioOnly(this.context.audioOnly);
      this.ffmpeg.on('close', () => {
        emitter.emit('close');
      });
      this.ffmpeg.on('end', () => {
        emitter.emit('end');
      });
      this.ffmpeg.on('error', (err) => {
        emitter.emit('error', err);
      });

      try {
        ffmpegOutStream = this.ffmpeg.spawnError(
          'oops',
          'oops',
          Math.min(stream.streamDetails?.duration ?? 30000, 60000),
        );
        if (isUndefined(ffmpegOutStream)) {
          throw new Error('Unable to spawn ffmpeg...what is going on here');
        }
        ffmpegOutStream.pipe(outStream);
      } catch (err) {
        this.logger.error(err, 'Err while trying to spawn error stream! YIKES');
      }

      emitter.emit('error', err);
    });
    return emitter;
  }
}
