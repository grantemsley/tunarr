import { Loaded, RequestContext } from '@mikro-orm/core';
import constants from '@tunarr/shared/constants';
import { isError, isNil, isUndefined, nth, once } from 'lodash-es';
import { PassThrough, Readable } from 'node:stream';
import { EntityManager } from '../dao/dataSource';
import {
  StreamLineupItem,
  createOfflineStreamLineupIteam,
} from '../dao/derived_types/StreamLineup';
import { Channel } from '../dao/entities/Channel';
import { getServerContext } from '../serverContext';
import { StreamQueryString } from '../types/schemas';
import { Maybe } from '../types/util';
import { fileExists } from '../util/fsUtil';
import { deepCopy } from '../util/index.js';
import { LoggerFactory } from '../util/logging/LoggerFactory';
import {
  StreamProgramCalculator,
  generateChannelContext,
} from './StreamProgramCalculator';
import { wereThereTooManyAttempts } from './StreamThrottler';
import { PlayerContext } from './Player';
import { ProgramPlayer } from './ProgramPlayer';
import { StreamContextChannel } from './types';

type VideoStreamSuccessResult = {
  type: 'success';
  stream: Readable;
  stop(): void;
};

type VideoStreamErrorResult = {
  type: 'error';
  httpStatus: number;
  message: string;
  error?: unknown;
};

type VideoStreamResult = VideoStreamSuccessResult | VideoStreamErrorResult;

/**
 * Starts a video stream for the given channel, playing the show airing at the
 * given timestamp
 */
export class VideoStream {
  private logger = LoggerFactory.child({ caller: import.meta });
  private calculator: StreamProgramCalculator;

  constructor() {
    this.calculator = getServerContext().streamProgramCalculator();
  }

  async startStream(
    req: StreamQueryString,
    startTimestamp: number,
    allowSkip: boolean,
  ): Promise<VideoStreamResult> {
    const start = performance.now();
    const serverCtx = getServerContext();
    const outStream = new PassThrough();

    if (isUndefined(req.channel)) {
      return {
        type: 'error',
        httpStatus: 400,
        message: 'No Channel Specified',
      };
    }

    const audioOnly = req.audioOnly;
    const session = req.session ?? 0;
    const m3u8 = req.m3u8 ?? false;
    const channel = await serverCtx.channelDB.getChannel(req.channel);

    if (isNil(channel)) {
      return {
        type: 'error',
        httpStatus: 404,
        message: `Channel ${req.channel} doesn't exist`,
      };
    }

    const lineup = await serverCtx.channelDB.loadLineup(channel.uuid);

    if (isNil(channel)) {
      return {
        type: 'error',
        httpStatus: 404,
        message: `Channel ${req.channel} doesn't exist`,
      };
    }

    const ffmpegSettings = serverCtx.settings.ffmpegSettings();

    // Check if ffmpeg path is valid
    if (!(await fileExists(ffmpegSettings.ffmpegExecutablePath))) {
      this.logger.error(
        `FFMPEG path (${ffmpegSettings.ffmpegExecutablePath}) is invalid. The file (executable) doesn't exist.`,
      );

      return {
        type: 'error',
        httpStatus: 500,
        message: `FFMPEG path (${ffmpegSettings.ffmpegExecutablePath}) is invalid. The file (executable) doesn't exist.`,
      };
    }

    let lineupItem: Maybe<StreamLineupItem>;
    let channelContext: Loaded<Channel> = channel;
    const redirectChannels: string[] = [];
    const upperBounds: number[] = [];

    let currentProgram = await this.calculator.getCurrentProgramAndTimeElapsed(
      startTimestamp,
      channel,
      lineup,
    );

    while (
      !isUndefined(currentProgram) &&
      currentProgram.program.type === 'redirect'
    ) {
      redirectChannels.push(channelContext.uuid);
      upperBounds.push(
        currentProgram.program.duration - currentProgram.timeElapsed,
      );

      if (redirectChannels.includes(currentProgram.program.channel)) {
        await serverCtx.channelCache.recordPlayback(
          channelContext.uuid,
          startTimestamp,
          {
            type: 'error',
            title: 'Error',
            error:
              'Recursive channel redirect found: ' +
              redirectChannels.join(', '),
            duration: 60000,
            start: 0,
          },
        );
      }

      const nextChannelId = currentProgram.program.channel;
      const newChannelAndLineup =
        await serverCtx.channelDB.loadChannelAndLineup(nextChannelId);

      if (isNil(newChannelAndLineup)) {
        const msg = "Invalid redirect to a channel that doesn't exist";
        this.logger.error(msg);
        currentProgram = {
          program: {
            ...createOfflineStreamLineupIteam(60000),
            type: 'error',
            error: msg,
          },
          timeElapsed: 0,
          programIndex: -1,
        };
        continue;
      }

      channelContext = newChannelAndLineup.channel;
      lineupItem = serverCtx.channelCache.getCurrentLineupItem(
        channelContext.uuid,
        startTimestamp,
      );

      if (!isUndefined(lineupItem)) {
        lineupItem = deepCopy(lineupItem);
        break;
      } else {
        currentProgram = await this.calculator.getCurrentProgramAndTimeElapsed(
          startTimestamp,
          channelContext,
          newChannelAndLineup.lineup,
        );
      }
    }

    if (isUndefined(lineupItem)) {
      if (isNil(currentProgram)) {
        return {
          type: 'error',
          httpStatus: 500,
          message: 'Could not find currentProgram for channel',
        };
      }

      if (
        currentProgram.program.type === 'offline' &&
        lineup.items.length === 1 &&
        currentProgram.programIndex !== -1
      ) {
        //there's only one program and it's offline. So really, the channel is
        //permanently offline, it doesn't matter what duration was set
        //and it's best to give it a long duration to ensure there's always
        //filler to play (if any)
        const t = 365 * 24 * 60 * 60 * 1000;
        currentProgram.program = createOfflineStreamLineupIteam(t);
      } else if (
        allowSkip &&
        currentProgram.program.type === 'offline' &&
        currentProgram.program.duration - currentProgram.timeElapsed <=
          constants.SLACK + 1
      ) {
        //it's pointless to show the offline screen for such a short time, might as well
        //skip to the next program
        const dt = currentProgram.program.duration - currentProgram.timeElapsed;
        for (let i = 0; i < redirectChannels.length; i++) {
          await serverCtx.channelCache.clearPlayback(redirectChannels[i]);
        }
        this.logger.info(
          'Too little time before the filler ends, skip to next slot',
        );
        return await this.startStream(req, startTimestamp + dt + 1, false);
      }
      if (isNil(currentProgram) || isNil(currentProgram.program)) {
        const msg =
          "No video to play, this means there's a serious unexpected bug or the channel db is corrupted.";
        this.logger.error(msg);
        return {
          type: 'error',
          httpStatus: 500,
          message: msg,
        };
      }

      lineupItem = await this.calculator.createLineupItem(
        currentProgram,
        channelContext,
      );
    }

    if (!isUndefined(lineupItem)) {
      let upperBound = Number.MAX_SAFE_INTEGER;
      const beginningOffset = lineupItem?.beginningOffset ?? 0;

      //adjust upper bounds and record playbacks
      for (let i = redirectChannels.length - 1; i >= 0; i--) {
        const thisUpperBound = nth(upperBounds, i);
        if (!isNil(thisUpperBound)) {
          const nextBound = thisUpperBound + beginningOffset;
          const prevBound = isNil(lineupItem.streamDuration)
            ? upperBound
            : Math.min(upperBound, lineupItem.streamDuration);
          const newDuration = Math.min(nextBound, prevBound);

          lineupItem = {
            ...lineupItem,
            streamDuration: newDuration,
          };
          upperBound = newDuration;
        }

        await serverCtx.channelCache.recordPlayback(
          redirectChannels[i],
          startTimestamp,
          lineupItem,
        );
      }
    }

    [
      '! Start playback',
      `! Channel: ${channel.name} (${channel.number})`,
      `! Title: ${lineupItem?.title ?? 'Unknown'}`,
      lineupItem.type === 'error'
        ? `! Error: ${
            isError(lineupItem.error)
              ? lineupItem.error.message
              : lineupItem.error
          }`
        : '',
      isUndefined(lineupItem?.streamDuration)
        ? `! From: ${lineupItem?.start}`
        : `! From: ${lineupItem?.start} to: ${
            (lineupItem?.start ?? 0) + (lineupItem?.streamDuration ?? 0)
          }`,
      `! Type: ${lineupItem?.type}`,
    ]
      .filter((s) => s.length > 0)
      .forEach((line) => this.logger.info(line));

    await serverCtx.channelCache.recordPlayback(
      channel.uuid,
      startTimestamp,
      lineupItem,
    );

    if (wereThereTooManyAttempts(session, lineupItem)) {
      lineupItem = {
        type: 'error',
        error: 'Too many attempts, throttling',
        duration: 60000,
        start: 0,
      };
    }

    const combinedChannel: StreamContextChannel = {
      ...generateChannelContext(channelContext),
      transcoding: channel.transcoding,
    };

    const playerContext: PlayerContext = {
      lineupItem,
      ffmpegSettings,
      channel: combinedChannel,
      m3u8,
      audioOnly: audioOnly,
      // A little hacky...
      entityManager: (
        RequestContext.getEntityManager()! as EntityManager
      ).fork(),
      settings: serverCtx.settings,
    };

    const player = new ProgramPlayer(playerContext);
    let stopped = false;

    const stop = () => {
      if (!stopped) {
        stopped = true;
        player.cleanUp();
        // End the stream
        // Unsure if this is right...
        outStream.push(null);
      }
    };

    try {
      this.logger.trace('About to play stream...');
      const ffmpegEmitter = await player.play(outStream);
      ffmpegEmitter?.on('error', (err) => {
        this.logger.error('Error while playing video: %O', err);
      });

      ffmpegEmitter?.on('end', () => {
        stop();
      });
    } catch (err) {
      this.logger.error(err, 'Error when attempting to play video');
      stop();
      return {
        type: 'error',
        httpStatus: 500,
        message: 'Unable to start playing video.',
        error: err,
      };
    }

    const logTimer = once(() => {
      const dur = performance.now() - start;
      this.logger.debug('Video stream started in %d ms', dur);
      outStream.off('data', logTimer);
    });
    outStream.on('data', logTimer);

    return {
      type: 'success',
      stream: outStream,
      stop,
    };
  }
}
