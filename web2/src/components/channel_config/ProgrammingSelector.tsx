import { Clear } from '@mui/icons-material';
import {
  Divider,
  FormControl,
  IconButton,
  InputAdornment,
  InputLabel,
  LinearProgress,
  List,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { DataTag, useInfiniteQuery } from '@tanstack/react-query';
import {
  PlexLibraryMovies,
  PlexLibraryShows,
  PlexMedia,
  PlexMovie,
  PlexTvShow,
  isPlexDirectory,
} from '@tunarr/types/plex';
import { chain, first, isEmpty, isNil, isUndefined } from 'lodash-es';
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIntersectionObserver } from 'usehooks-ts';
import { fetchPlexPath, usePlex } from '../../hooks/plexHooks.ts';
import { usePlexServerSettings } from '../../hooks/settingsHooks.ts';
import useDebouncedState from '../../hooks/useDebouncedState.ts';
import { addPlexMediaToCurrentChannel } from '../../store/channelEditor/actions.ts';
import useStore from '../../store/index.ts';
import {
  addKnownMediaForServer,
  setProgrammingListLibrary,
  setProgrammingListingServer,
} from '../../store/programmingSelector/actions.ts';
import AddSelectedMediaButton from './AddSelectedMediaButton.tsx';
import { PlexListItem } from './PlexListItem.tsx';
import SelectedProgrammingList from './SelectedProgrammingList.tsx';

export interface PlexListItemProps<T extends PlexMedia> {
  item: T;
  style?: React.CSSProperties;
  index?: number;
  length: number;
  parent?: string;
}

export default function ProgrammingSelector() {
  const { data: plexServers } = usePlexServerSettings();
  const selectedServer = useStore((s) => s.currentServer);
  const selectedLibrary = useStore((s) => s.currentLibrary);
  // const listingsByServer = useStore((s) => s.listingsByServer);
  const knownMedia = useStore((s) => s.knownMediaByServer);
  // const hierarchyByServer = useStore((s) => s.contentHierarchyByServer);
  const navigate = useNavigate();

  useEffect(() => {
    const server =
      !isUndefined(plexServers) && !isEmpty(plexServers)
        ? plexServers[0]
        : undefined;

    setProgrammingListingServer(server);
  }, [plexServers]);

  const [scrollParams, setScrollParams] = useState({ limit: 0, max: -1 });
  const [search, debounceSearch, setSearch] = useDebouncedState('', 300);

  const { data: directoryChildren } = usePlex(
    selectedServer?.name ?? '',
    '/library/sections',
    !isUndefined(selectedServer),
  );

  useEffect(() => {
    if (directoryChildren) {
      if (directoryChildren.size > 0) {
        setProgrammingListLibrary(directoryChildren.Directory[0]);
      }
      addKnownMediaForServer(selectedServer!.name, [
        ...directoryChildren.Directory,
      ]);
    }
  }, [selectedServer, directoryChildren]);

  const { isLoading: searchLoading, data: searchData } = useInfiniteQuery({
    queryKey: [
      'plex-search',
      selectedServer?.name,
      selectedLibrary?.key,
      debounceSearch,
    ] as DataTag<
      ['plex-search', string, string, string],
      PlexLibraryMovies | PlexLibraryShows
    >,
    enabled: !isNil(selectedServer) && !isNil(selectedLibrary),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const plexQuery = new URLSearchParams({
        'Plex-Container-Start': pageParam.toString(),
        'Plex-Container-Size': '10',
      });

      if (!isNil(debounceSearch) && !isEmpty(debounceSearch)) {
        plexQuery.set('title<', debounceSearch);
      }

      return fetchPlexPath<PlexLibraryMovies | PlexLibraryShows>(
        selectedServer!.name,
        `/library/sections/${selectedLibrary!.key}/all?${plexQuery.toString()}`,
      )();
    },
    getNextPageParam: (res, _, last) => {
      if (res.size < 10) {
        return null;
      }

      return last + 10;
    },
  });

  useEffect(() => {
    if (searchData) {
      // We're using this as an analogue for detecting the start of a new 'query'
      if (searchData.pages.length === 1) {
        setScrollParams({
          limit: 10,
          max: first(searchData.pages)!.size,
        });
      }

      // We probably wouldn't have made it this far if we didnt have a server, but
      // putting this here to prevent crashes
      if (selectedServer) {
        const allMedia = chain(searchData.pages)
          .reject((page) => page.size === 0)
          .map((page) => page.Metadata)
          .flatten()
          .value();
        addKnownMediaForServer(selectedServer.name, allMedia);
      }
    }
  }, [selectedServer, searchData, setScrollParams]);

  const onLibraryChange = useCallback(
    (libraryUuid: string) => {
      if (selectedServer) {
        const known = knownMedia[selectedServer.name] ?? {};
        const library = known[libraryUuid];
        if (library && isPlexDirectory(library)) {
          setProgrammingListLibrary(library);
        }
      }
    },
    [knownMedia, selectedServer],
  );

  const { ref } = useIntersectionObserver({
    onChange: (_, entry) => {
      if (entry.isIntersecting && scrollParams.limit < scrollParams.max) {
        setScrollParams(({ limit: prevLimit, max }) => ({
          max,
          limit: prevLimit + 10,
        }));
      }
    },
    threshold: 0.5,
  });

  const clearSearchInput = useCallback(() => {
    setSearch('');
  }, [setSearch]);

  const renderListItems = () => {
    if (!searchData) {
      return null;
    }

    return chain(searchData.pages)
      .reject((page) => page.size === 0)
      .map((page) => page.Metadata)
      .flatten()
      .take(scrollParams.limit)
      .map((item: PlexMovie | PlexTvShow) => {
        return <PlexListItem key={item.guid} item={item} />;
      })
      .value();
  };

  return (
    <>
      {selectedServer && (
        <FormControl fullWidth size="small" margin="dense">
          <InputLabel>Media Source</InputLabel>
          <Select label="Media Source" value={selectedServer?.name}>
            {plexServers?.map((server) => (
              <MenuItem key={server.name} value={server.name}>
                Plex: {server.name}
              </MenuItem>
            ))}
            <MenuItem value="custom-shows">Custom Shows</MenuItem>
          </Select>
        </FormControl>
      )}
      {!isNil(directoryChildren) &&
        directoryChildren.size > 0 &&
        selectedLibrary && (
          <>
            <FormControl fullWidth size="small" margin="normal">
              <InputLabel>Library</InputLabel>
              <Select
                label="Library"
                value={selectedLibrary.uuid}
                onChange={(e) => onLibraryChange(e.target.value)}
              >
                {directoryChildren.Directory.map((dir) => (
                  <MenuItem key={dir.key} value={dir.uuid}>
                    {dir.title}
                  </MenuItem>
                ))}
                <MenuItem value="custom-shows">Custom Shows</MenuItem>
              </Select>
            </FormControl>
            <TextField
              size="small"
              label="Search"
              margin="dense"
              variant="outlined"
              fullWidth
              value={search}
              disabled={searchLoading}
              onChange={(e) => setSearch(e.target.value)}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      onClick={clearSearchInput}
                      onMouseDown={(e) => e.preventDefault()}
                      edge="end"
                    >
                      <Clear />
                    </IconButton>
                  </InputAdornment>
                ),
              }}
            />
          </>
        )}
      <LinearProgress
        sx={{ visibility: searchLoading ? 'visible' : 'hidden' }}
      />
      <List
        component="nav"
        sx={{ mt: 2, width: '100%', maxHeight: 400, overflowY: 'scroll' }}
      >
        {selectedServer && renderListItems()}
        <div style={{ height: 40 }} ref={ref}></div>
      </List>
      <Divider sx={{ mt: 3, mb: 2 }} />
      <Typography>Selected Items</Typography>
      <SelectedProgrammingList />
      <AddSelectedMediaButton
        onAdd={addPlexMediaToCurrentChannel}
        onSuccess={() => navigate('..', { relative: 'path' })}
      />
    </>
  );
}
