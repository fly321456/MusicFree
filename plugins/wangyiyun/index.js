/**
 * 网易云音乐 MusicFree 插件
 * 支持搜索、播放、歌单导入、榜单和推荐歌单功能
 * 版本: 1.1.0
 */

// ==================== 常量定义 ====================

const PLATFORM_NAME = '网易云音乐';
const API_BASE_URL = 'https://music.163.com';
const API_Y_BASE_URL = 'https://y.music.163.com';

// 通用请求头
const COMMON_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: 'https://music.163.com/',
    'Content-Type': 'application/json',
};

// 请求配置
const REQUEST_CONFIG = {
    DEFAULT_TIMEOUT: 10000, // 10秒超时
    MAX_RETRIES: 3,
    RETRY_DELAY_BASE: 1000, // 基础延迟1秒
    BATCH_SIZE: 200, // 批量请求大小
    CONCURRENT_LIMIT: 3, // 并发请求限制
};

// 音质映射
const QUALITY_MAP = {
    low: 128000,
    standard: 128000,
    high: 192000,
    super: 320000,
};

// 搜索类型映射
const SEARCH_TYPE_MAP = {
    music: 1,
    album: 10,
    artist: 100,
    sheet: 1000,
};

// ==================== 工具函数 ====================

/**
 * 构建请求头
 * @param {Object} extraHeaders - 额外的请求头
 * @param {string} baseUrl - 基础URL，用于设置Referer和Origin
 * @returns {Object} 请求头对象
 */
function buildHeaders(extraHeaders, baseUrl) {
    extraHeaders = extraHeaders || {};
    baseUrl = baseUrl || API_BASE_URL;

    const headers = {
        'User-Agent': COMMON_HEADERS['User-Agent'],
        Referer: baseUrl + '/',
        Origin: baseUrl,
    };

    // 手动合并额外请求头（避免使用展开运算符，提高兼容性）
    const keys = Object.keys(extraHeaders);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        headers[key] = extraHeaders[key];
    }

    return headers;
}

/**
 * 验证URL是否有效
 * @param {string} url - URL字符串
 * @returns {boolean} 是否有效
 */
function isValidUrl(url) {
    if (!url) {
        return false;
    }
    if (typeof url !== 'string') {
        return false;
    }
    const trimmed = url.trim();
    if (trimmed.length === 0) {
        return false;
    }
    if (trimmed === 'null' || trimmed === 'undefined') {
        return false;
    }
    // 检查是否以 http:// 或 https:// 开头
    return trimmed.startsWith('http://') || trimmed.startsWith('https://');
}

/**
 * 计算分页信息
 * @param {number} total - 总数
 * @param {number} currentPage - 当前页码
 * @param {number} limit - 每页数量
 * @param {number} currentCount - 当前返回数量
 * @returns {boolean} 是否结束
 */
function calculateIsEnd(total, currentPage, limit, currentCount) {
    return total <= currentPage * limit || currentCount < limit;
}

/**
 * 带超时和重试的请求函数
 * @param {string} url - 请求URL
 * @param {Object} options - 请求选项
 * @param {number} maxRetries - 最大重试次数
 * @param {number} timeout - 超时时间（毫秒）
 */
async function fetchWithRetry(url, options, maxRetries, timeout) {
    options = options || {};
    maxRetries = maxRetries || REQUEST_CONFIG.MAX_RETRIES || 3;
    timeout = timeout || REQUEST_CONFIG.DEFAULT_TIMEOUT || 10000;

    let lastError;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(url, options);
            if (response.ok) {
                return await response.json();
            }
            throw new Error(
                'HTTP ' + response.status + ': ' + response.statusText,
            );
        } catch (error) {
            lastError = error;
            if (i < maxRetries - 1) {
                // 等待后重试，指数退避
                const delay =
                    (REQUEST_CONFIG.RETRY_DELAY_BASE || 1000) * Math.pow(2, i);
                await new Promise(function (resolve) {
                    setTimeout(resolve, delay);
                });
            }
        }
    }
    throw lastError;
}

/**
 * 解析歌单ID（支持多种URL格式）
 * @param {string} urlLike - 歌单链接或ID
 * @returns {string|null} 歌单ID
 */
function parsePlaylistId(urlLike) {
    if (!urlLike || typeof urlLike !== 'string') {
        return null;
    }

    const trimmed = urlLike.trim();

    // URL格式匹配
    const regexes = [
        /music\.163\.com.*playlist\?id=(\d+)/,
        /music\.163\.com.*playlist\/(\d+)/,
        /playlist\?id=(\d+)/,
        /playlist\/(\d+)/,
        /\/playlist\/(\d+)/,
    ];

    for (const regex of regexes) {
        const match = trimmed.match(regex);
        if (match && match[1]) {
            return match[1];
        }
    }

    // 直接输入的数字ID
    if (/^\d+$/.test(trimmed)) {
        return trimmed;
    }

    return null;
}

/**
 * 批量获取歌曲详情（带并发控制）
 * @param {Array<number>} songIds - 歌曲ID数组
 * @returns {Promise<Array>} 歌曲详情数组
 */
async function batchGetSongDetails(songIds) {
    if (!songIds || songIds.length === 0) {
        return [];
    }

    const allSongs = [];
    const batchSize = REQUEST_CONFIG.BATCH_SIZE;

    // 分批处理
    for (let i = 0; i < songIds.length; i += batchSize) {
        const batch = songIds.slice(i, i + batchSize);

        try {
            const response = await fetchWithRetry(
                `${API_BASE_URL}/api/song/detail/?ids=[${batch.join(',')}]`,
                {
                    method: 'GET',
                    headers: buildHeaders({}, API_Y_BASE_URL),
                },
                2, // 减少重试次数
                8000, // 8秒超时
            );

            if (response.songs && Array.isArray(response.songs)) {
                // 使用 apply 代替展开运算符，提高兼容性
                allSongs.push.apply(allSongs, response.songs);
            }
        } catch (error) {
            // 静默失败，继续处理下一批，不中断整个流程
            // 批量请求中部分失败不影响整体结果
        }
    }

    return allSongs;
}

/**
 * 将歌曲数据标准化为MusicFree格式
 * @param {Object} song - 网易云歌曲对象
 * @returns {Object} 标准化的歌曲对象
 */
function normalizeMusicItem(song) {
    if (!song || !song.id) {
        return null;
    }

    // duration 需要转换为秒（网易云返回的是毫秒）
    const duration = song.dt || song.duration || 0;
    const durationInSeconds =
        typeof duration === 'number' ? Math.floor(duration / 1000) : 0;

    // 处理艺术家信息
    const artists = song.ar || song.artists || [];
    const artistName =
        Array.isArray(artists) && artists.length > 0
            ? artists
                  .map(artist => artist.name || '')
                  .filter(Boolean)
                  .join('/')
            : '未知艺术家';

    // 处理专辑信息
    const album = song.al || song.album || {};
    const albumName = album.name || '未知专辑';
    const artwork = album.picUrl || album.pic || '';

    return {
        id: String(song.id), // 确保 id 是字符串类型
        title: song.name || song.title || '未知歌曲',
        artist: artistName,
        album: albumName,
        duration: durationInSeconds,
        artwork: artwork,
        platform: PLATFORM_NAME,
    };
}

/**
 * 标准化专辑数据
 * @param {Object} album - 网易云专辑对象
 * @returns {Object} 标准化的专辑对象
 */
function normalizeAlbumItem(album) {
    if (!album || !album.id) {
        return null;
    }

    return {
        id: String(album.id),
        title: album.name || '未知专辑',
        artist: (album.artist || {}).name || '未知艺术家',
        artwork: album.picUrl || album.pic || '',
        description: album.description || '',
        date: album.publishTime
            ? new Date(album.publishTime).toISOString().split('T')[0]
            : '',
        platform: PLATFORM_NAME,
    };
}

/**
 * 标准化艺术家数据
 * @param {Object} artist - 网易云艺术家对象
 * @returns {Object} 标准化的艺术家对象
 */
function normalizeArtistItem(artist) {
    if (!artist || !artist.id) {
        return null;
    }

    return {
        id: String(artist.id),
        name: artist.name || '未知艺术家',
        avatar: artist.picUrl || artist.pic || '',
        description: artist.briefDesc || '',
        platform: PLATFORM_NAME,
    };
}

// ==================== 插件导出 ====================

module.exports = {
    platform: PLATFORM_NAME,
    version: '1.1.0',
    author: 'MusicFree Plugin',
    description: '网易云音乐插件，支持搜索、播放、歌单导入、榜单和推荐歌单功能',

    // 定义插件支持的搜索类型
    supportedSearchType: ['music', 'album', 'artist', 'sheet'],

    // 缓存控制策略
    cacheControl: 'cache',

    // 提示信息
    hints: {
        importMusicSheet: [
            '网易云移动端：APP点击分享，然后复制链接',
            '网易云H5/PC端：复制URL，或者直接输入歌单ID即可',
            '默认歌单无法导入，先新建一个空白歌单复制过去再导入新歌单即可',
        ],
    },

    /**
     * 搜索功能
     * @param {string} query - 搜索关键词
     * @param {number} page - 页码，从1开始
     * @param {string} type - 搜索类型：music, album, artist, sheet
     */
    async search(query, page, type) {
        try {
            if (!query || !query.trim()) {
                return {
                    isEnd: true,
                    data: [],
                };
            }

            const searchType =
                SEARCH_TYPE_MAP[type] || SEARCH_TYPE_MAP['music'];
            const limit = 20;
            const offset = (page - 1) * limit;

            let response;
            let result = {};

            // 方案1: 尝试使用 cloudsearch/pc API
            try {
                response = await fetchWithRetry(
                    `${API_BASE_URL}/api/cloudsearch/pc`,
                    {
                        method: 'POST',
                        headers: buildHeaders({
                            'Content-Type': 'application/json',
                        }),
                        body: JSON.stringify({
                            s: query.trim(),
                            type: searchType,
                            limit: limit,
                            offset: offset,
                        }),
                    },
                    2, // 最大重试2次
                    8000, // 8秒超时
                );

                if (response && response.result) {
                    result = response.result;
                } else if (
                    response &&
                    response.code === 200 &&
                    response.result
                ) {
                    result = response.result;
                }
            } catch (error) {
                console.log(
                    'cloudsearch/pc API 失败，尝试备用方案:',
                    error.message,
                );
            }

            // 方案2: 如果第一个API失败，尝试使用搜索建议API作为备用
            if (!result || Object.keys(result).length === 0) {
                try {
                    const suggestResponse = await fetchWithRetry(
                        `${API_BASE_URL}/api/search/suggest/web?keywords=${encodeURIComponent(
                            query.trim(),
                        )}&type=${searchType}`,
                        {
                            method: 'GET',
                            headers: {
                                'User-Agent': COMMON_HEADERS['User-Agent'],
                                Referer: COMMON_HEADERS['Referer'],
                            },
                        },
                        1, // 只重试1次
                        5000, // 5秒超时
                    );

                    if (suggestResponse && suggestResponse.result) {
                        // 将建议结果转换为搜索结果格式
                        if (type === 'music' && suggestResponse.result.songs) {
                            result.songs = suggestResponse.result.songs.slice(
                                0,
                                limit,
                            );
                            result.songCount =
                                suggestResponse.result.songs.length;
                        } else if (
                            type === 'album' &&
                            suggestResponse.result.albums
                        ) {
                            result.albums = suggestResponse.result.albums.slice(
                                0,
                                limit,
                            );
                            result.albumCount =
                                suggestResponse.result.albums.length;
                        } else if (
                            type === 'artist' &&
                            suggestResponse.result.artists
                        ) {
                            result.artists =
                                suggestResponse.result.artists.slice(0, limit);
                            result.artistCount =
                                suggestResponse.result.artists.length;
                        }
                    }
                } catch (error) {
                    console.log('搜索建议API也失败:', error.message);
                }
            }

            // 处理不同类型的搜索结果
            if (type === 'music') {
                const songs = result.songs || [];
                const songCount = result.songCount || songs.length;

                return {
                    isEnd: calculateIsEnd(songCount, page, limit, songs.length),
                    data: songs
                        .map(song => normalizeMusicItem(song))
                        .filter(Boolean), // 过滤掉null值
                };
            } else if (type === 'album') {
                const albums = result.albums || [];
                const albumCount = result.albumCount || albums.length;

                return {
                    isEnd: calculateIsEnd(
                        albumCount,
                        page,
                        limit,
                        albums.length,
                    ),
                    data: albums
                        .map(album => normalizeAlbumItem(album))
                        .filter(Boolean),
                };
            } else if (type === 'artist') {
                const artists = result.artists || [];
                const artistCount = result.artistCount || artists.length;

                return {
                    isEnd: calculateIsEnd(
                        artistCount,
                        page,
                        limit,
                        artists.length,
                    ),
                    data: artists
                        .map(artist => normalizeArtistItem(artist))
                        .filter(Boolean),
                };
            } else if (type === 'sheet') {
                const playlists = result.playlists || [];
                const playlistCount = result.playlistCount || playlists.length;

                return {
                    isEnd: calculateIsEnd(
                        playlistCount,
                        page,
                        limit,
                        playlists.length,
                    ),
                    data: playlists
                        .map(playlist => ({
                            id: String(playlist.id || ''),
                            title: playlist.name || '未知歌单',
                            description: playlist.description || '',
                            coverImg:
                                playlist.coverImgUrl || playlist.picUrl || '',
                            artwork:
                                playlist.coverImgUrl || playlist.picUrl || '',
                            playCount: playlist.playCount || 0,
                            worksNum: playlist.trackCount || 0,
                            platform: PLATFORM_NAME,
                        }))
                        .filter(item => item.id), // 过滤无效项
                };
            }

            return {
                isEnd: true,
                data: [],
            };
        } catch (error) {
            console.error('搜索失败:', {
                query: query,
                type: type,
                page: page,
                error: error.message,
            });
            return {
                isEnd: true,
                data: [],
            };
        }
    },

    /**
     * 获取音频播放地址
     * @param {Object} musicItem - 音乐项
     * @param {string} quality - 音质：low, standard, high, super
     */
    async getMediaSource(musicItem, quality) {
        try {
            if (!musicItem || !musicItem.id) {
                throw new Error('无效的音乐项');
            }

            const songId = String(musicItem.id);
            const br = QUALITY_MAP[quality] || QUALITY_MAP['standard'];

            // 获取歌曲播放URL
            let audioUrl = null;
            let lastError = null;

            // 方案1: 尝试新的API端点 v1
            try {
                const response = await fetchWithRetry(
                    `${API_BASE_URL}/api/song/url/v1?id=${songId}&level=exhigh&encodeType=mp3`,
                    {
                        method: 'GET',
                        headers: buildHeaders(),
                    },
                    2, // 减少重试次数，快速失败
                    5000, // 5秒超时
                );

                if (response.data && response.data.length > 0) {
                    const urlData = response.data[0];
                    if (isValidUrl(urlData.url)) {
                        audioUrl = urlData.url.trim();
                    }
                }
            } catch (error) {
                lastError = error;
                console.log('新API v1调用失败:', error.message);
            }

            // 方案2: 尝试旧版API
            if (!audioUrl) {
                try {
                    const oldResponse = await fetchWithRetry(
                        `${API_BASE_URL}/api/song/enhance/player/url?ids=[${songId}]&br=${br}`,
                        {
                            method: 'GET',
                            headers: {
                                'User-Agent': COMMON_HEADERS['User-Agent'],
                                Referer: COMMON_HEADERS['Referer'],
                            },
                        },
                        2,
                        5000,
                    );

                    if (oldResponse.data && oldResponse.data.length > 0) {
                        const urlData = oldResponse.data[0];
                        if (isValidUrl(urlData.url)) {
                            audioUrl = urlData.url.trim();
                        }
                    }
                } catch (error) {
                    lastError = error;
                    console.log('旧API调用失败:', error.message);
                }
            }

            // 方案3: 尝试另一个API端点
            if (!audioUrl) {
                try {
                    const altResponse = await fetchWithRetry(
                        `${API_BASE_URL}/api/song/url?id=${songId}&ids=[${songId}]&br=${br}`,
                        {
                            method: 'GET',
                            headers: {
                                'User-Agent': COMMON_HEADERS['User-Agent'],
                                Referer: COMMON_HEADERS['Referer'],
                            },
                        },
                        1, // 只重试1次
                        5000,
                    );

                    if (altResponse.data && altResponse.data.length > 0) {
                        const urlData = altResponse.data[0];
                        if (isValidUrl(urlData.url)) {
                            audioUrl = urlData.url.trim();
                        }
                    }
                } catch (error) {
                    lastError = error;
                    console.log('备用API调用失败:', error.message);
                }
            }

            // 方案4: 如果所有直接API都失败，使用代理服务作为备选方案
            if (!audioUrl) {
                try {
                    // 代理服务URL格式：https://share.duanx.cn/url/wy/{songId}
                    const proxyUrl = `https://share.duanx.cn/url/wy/${songId}`;

                    // 直接使用代理URL，不进行预检查（某些代理服务可能不支持HEAD请求）
                    audioUrl = proxyUrl;
                } catch (error) {
                    lastError = error;
                    console.log('代理服务设置失败:', error.message);
                }
            }

            // 最终验证
            if (!isValidUrl(audioUrl)) {
                const errorMsg = lastError
                    ? `无法获取音频链接: ${lastError.message}`
                    : '无法获取音频链接，歌曲可能为VIP、下架或暂无版权';
                throw new Error(errorMsg);
            }

            // 清理URL（移除可能的空格）
            audioUrl = audioUrl.trim();

            return {
                url: audioUrl,
                headers: {
                    'User-Agent': COMMON_HEADERS['User-Agent'],
                    Referer: COMMON_HEADERS['Referer'],
                },
            };
        } catch (error) {
            console.error('获取媒体源失败:', {
                songId: musicItem?.id,
                title: musicItem?.title,
                error: error.message,
            });
            return null;
        }
    },

    /**
     * 获取歌词
     * @param {Object} musicItem - 音乐项
     */
    async getLyric(musicItem) {
        try {
            if (!musicItem || !musicItem.id) {
                return null;
            }

            const songId = String(musicItem.id);

            // 调用网易云歌词API
            const response = await fetchWithRetry(
                `${API_BASE_URL}/api/song/lyric?id=${songId}&lv=-1&tv=-1`,
                {
                    method: 'GET',
                    headers: {
                        'User-Agent': COMMON_HEADERS['User-Agent'],
                        Referer: COMMON_HEADERS['Referer'],
                    },
                },
                2,
                8000,
            );

            // 提取歌词和翻译
            const lrc = response.lrc?.lyric || '';
            const tlyric = response.tlyric?.lyric || '';

            if (!lrc && !tlyric) {
                return null;
            }

            return {
                rawLrc: lrc || undefined,
                translation: tlyric || undefined,
            };
        } catch (error) {
            console.error('获取歌词失败:', error);
            return null;
        }
    },

    /**
     * 获取歌单详情和歌曲列表
     * @param {Object} sheetItem - 歌单项
     * @param {number} page - 页码，从1开始
     */
    async getMusicSheetInfo(sheetItem, page = 1) {
        try {
            const playlistId = String(sheetItem.id || '');
            if (!playlistId) {
                throw new Error('无效的歌单ID');
            }

            const limit = 50; // 每页50首
            const offset = (page - 1) * limit;

            // 方案1: 尝试使用 v3 API 获取歌单详情（支持更多歌曲和分页）
            let response;
            let allTracks = [];
            let playlistInfo = null;

            try {
                response = await fetchWithRetry(
                    `${API_BASE_URL}/api/v3/playlist/detail?id=${playlistId}&n=10000`,
                    {
                        method: 'GET',
                        headers: buildHeaders({}, API_Y_BASE_URL),
                    },
                    2,
                    10000,
                );

                if (response.playlist) {
                    playlistInfo = response.playlist;

                    // v3 API 返回 trackIds，需要分批获取歌曲详情
                    if (
                        response.playlist.trackIds &&
                        Array.isArray(response.playlist.trackIds)
                    ) {
                        const trackIds = response.playlist.trackIds.map(
                            item => item.id,
                        );

                        // 计算当前页需要获取的歌曲范围
                        const startIndex = offset;
                        const endIndex = Math.min(
                            offset + limit,
                            trackIds.length,
                        );
                        const pageTrackIds = trackIds.slice(
                            startIndex,
                            endIndex,
                        );

                        // 使用优化的批量获取函数
                        const batchSongs = await batchGetSongDetails(
                            pageTrackIds,
                        );
                        // 使用 apply 代替展开运算符，提高兼容性
                        allTracks.push.apply(allTracks, batchSongs);
                    } else if (
                        response.playlist.tracks &&
                        Array.isArray(response.playlist.tracks)
                    ) {
                        // 如果直接返回了 tracks，使用它们
                        const tracks = response.playlist.tracks;
                        const startIndex = offset;
                        const endIndex = Math.min(
                            offset + limit,
                            tracks.length,
                        );
                        allTracks = tracks.slice(startIndex, endIndex);
                    }
                }
            } catch (v3Error) {
                console.log('v3 API 失败，尝试旧版 API:', v3Error.message);
            }

            // 方案2: 如果 v3 API 失败，尝试旧版 API
            if (allTracks.length === 0 && !playlistInfo) {
                try {
                    response = await fetchWithRetry(
                        `${API_BASE_URL}/api/playlist/detail?id=${playlistId}`,
                        {
                            method: 'GET',
                            headers: {
                                'User-Agent': COMMON_HEADERS['User-Agent'],
                                Referer: COMMON_HEADERS['Referer'],
                            },
                        },
                        2,
                        8000,
                    );

                    if (response.playlist) {
                        playlistInfo = response.playlist;
                        const tracks = response.playlist.tracks || [];

                        // 分页处理
                        const startIndex = offset;
                        const endIndex = Math.min(
                            offset + limit,
                            tracks.length,
                        );
                        allTracks = tracks.slice(startIndex, endIndex);
                    }
                } catch (error) {
                    console.log('旧版 API 也失败:', error.message);
                }
            }

            if (!playlistInfo) {
                throw new Error('歌单不存在或无法访问');
            }

            // 构建返回结果
            const totalTracks =
                playlistInfo.trackIds?.length ||
                playlistInfo.trackCount ||
                allTracks.length;
            const isEnd = calculateIsEnd(
                totalTracks,
                page,
                limit,
                allTracks.length,
            );

            return {
                sheetItem: {
                    id: String(playlistInfo.id || sheetItem.id),
                    title: playlistInfo.name || sheetItem.title || '未知歌单',
                    description:
                        playlistInfo.description || sheetItem.description || '',
                    coverImg:
                        playlistInfo.coverImgUrl ||
                        playlistInfo.picUrl ||
                        sheetItem.coverImg ||
                        '',
                    artwork:
                        playlistInfo.coverImgUrl ||
                        playlistInfo.picUrl ||
                        sheetItem.artwork ||
                        '',
                    artist:
                        playlistInfo.creator?.nickname ||
                        sheetItem.artist ||
                        '未知用户',
                    playCount:
                        playlistInfo.playCount || sheetItem.playCount || 0,
                    worksNum: totalTracks || sheetItem.worksNum || 0,
                    platform: PLATFORM_NAME,
                },
                musicList: allTracks.map(track => normalizeMusicItem(track)),
                isEnd: isEnd,
            };
        } catch (error) {
            console.error('获取歌单详情失败:', error);
            return {
                sheetItem: sheetItem,
                musicList: [],
                isEnd: true,
            };
        }
    },

    /**
     * 导入歌单
     * @param {string} urlLike - 歌单链接或ID
     */
    async importMusicSheet(urlLike) {
        try {
            const playlistId = parsePlaylistId(urlLike);
            if (!playlistId) {
                throw new Error('无效的歌单链接或ID');
            }

            // 方案1: 尝试使用 v3 API 获取歌单详情（支持更多歌曲）
            let response;
            try {
                response = await fetchWithRetry(
                    `${API_BASE_URL}/api/v3/playlist/detail?id=${playlistId}&n=5000`,
                    {
                        method: 'GET',
                        headers: buildHeaders({}, API_Y_BASE_URL),
                    },
                    2,
                    10000,
                );

                // v3 API 返回 trackIds，需要分批获取歌曲详情
                if (response.playlist && response.playlist.trackIds) {
                    const trackIds = response.playlist.trackIds.map(
                        item => item.id,
                    );
                    const allTracks = await batchGetSongDetails(trackIds);

                    if (allTracks.length > 0) {
                        return allTracks
                            .map(track => normalizeMusicItem(track))
                            .filter(Boolean);
                    }
                }
            } catch (v3Error) {
                console.log('v3 API 失败，尝试旧版 API:', v3Error.message);
            }

            // 方案2: 如果 v3 API 失败，尝试旧版 API
            response = await fetchWithRetry(
                `${API_BASE_URL}/api/playlist/detail?id=${playlistId}`,
                {
                    method: 'GET',
                    headers: {
                        'User-Agent': COMMON_HEADERS['User-Agent'],
                        Referer: COMMON_HEADERS['Referer'],
                    },
                },
                2,
                8000,
            );

            const playlist = response.playlist;
            if (!playlist) {
                throw new Error('歌单不存在或无法访问');
            }

            const tracks = playlist.tracks || [];
            if (tracks.length === 0) {
                return [];
            }

            // 将歌单中的歌曲数据标准化
            return tracks
                .map(track => normalizeMusicItem(track))
                .filter(Boolean);
        } catch (error) {
            console.error('导入歌单失败:', error);
            throw error;
        }
    },

    /**
     * 获取榜单列表
     */
    async getTopLists() {
        try {
            const response = await fetchWithRetry(
                `${API_BASE_URL}/api/toplist`,
                {
                    method: 'GET',
                    headers: {
                        'User-Agent': COMMON_HEADERS['User-Agent'],
                        Referer: COMMON_HEADERS['Referer'],
                    },
                },
                2,
                8000,
            );

            const list = response.list || [];

            return list.map(item => ({
                title: item.name || '未知榜单',
                data: (item.list || []).map(listItem => ({
                    id: String(listItem.id || ''),
                    title: listItem.name || listItem.title || '未知榜单',
                    description:
                        listItem.description ||
                        `更新频率：${listItem.updateFrequency || '未知'}`,
                    coverImg: listItem.coverImgUrl || listItem.picUrl || '',
                    playCount: listItem.playCount || 0,
                    // 额外信息，用于后续获取详情
                    extra: {
                        source: 'netease',
                        topId: String(listItem.id || ''),
                    },
                    platform: PLATFORM_NAME,
                })),
            }));
        } catch (error) {
            console.error('获取榜单列表失败:', error);
            return [];
        }
    },

    /**
     * 获取榜单详情
     * @param {Object} topListItem - 榜单项
     * @param {number} page - 页码，从1开始
     */
    async getTopListDetail(topListItem, page = 1) {
        try {
            const topId = String(
                topListItem.extra?.topId || topListItem.id || '',
            );
            if (!topId) {
                throw new Error('无效的榜单ID');
            }

            const response = await fetchWithRetry(
                `${API_BASE_URL}/api/toplist/detail?id=${topId}`,
                {
                    method: 'GET',
                    headers: {
                        'User-Agent': COMMON_HEADERS['User-Agent'],
                        Referer: COMMON_HEADERS['Referer'],
                    },
                },
                2,
                8000,
            );

            const playlist = response.playlist || {};
            const tracks = playlist.tracks || [];

            return {
                topListItem: topListItem,
                musicList: tracks
                    .map(song => normalizeMusicItem(song))
                    .filter(Boolean),
                isEnd: true, // 榜单通常一次获取全部，无分页
            };
        } catch (error) {
            console.error('获取榜单详情失败:', error);
            return {
                topListItem: topListItem,
                musicList: [],
                isEnd: true,
            };
        }
    },

    /**
     * 获取推荐歌单分类标签
     */
    async getRecommendSheetTags() {
        try {
            // 调用网易云推荐歌单分类API
            const response = await fetchWithRetry(
                `${API_BASE_URL}/api/playlist/catlist`,
                {
                    method: 'GET',
                    headers: {
                        'User-Agent': COMMON_HEADERS['User-Agent'],
                        Referer: COMMON_HEADERS['Referer'],
                    },
                },
                2,
                8000,
            );

            const categories = response.categories || {};
            const sub = response.sub || [];
            const all = response.all || {};

            // 构建分类数据
            const categoryGroups = [];
            const pinned = [];

            // 首先添加"推荐"选项（热门推荐歌单）
            pinned.push({
                id: '推荐',
                title: '推荐',
                platform: PLATFORM_NAME,
            });

            // 处理热门分类（置顶）- 添加"全部"和热门分类
            if (all.name) {
                pinned.push({
                    id: '全部',
                    title: all.name,
                    platform: PLATFORM_NAME,
                });
            }

            // 添加热门分类到置顶（华语、欧美、日韩、粤语等）
            const hotCategories = [
                '华语',
                '欧美',
                '日韩',
                '粤语',
                '流行',
                '摇滚',
                '民谣',
                '电子',
                '说唱',
                'R&B',
                '爵士',
                '古典',
                '轻音乐',
            ];
            const hotSubItems = sub.filter(item =>
                hotCategories.includes(item.name),
            );
            for (const item of hotSubItems) {
                pinned.push({
                    id: String(item.name || ''),
                    title: item.name || '未知分类',
                    platform: PLATFORM_NAME,
                });
            }

            // 按分类组织数据
            const categoryMap = {};
            for (const item of sub) {
                // 跳过已经添加到置顶的热门分类
                if (hotCategories.includes(item.name)) {
                    continue;
                }

                const categoryId = item.category || 0;
                const categoryName = categories[categoryId]?.name || '其他';

                if (!categoryMap[categoryName]) {
                    categoryMap[categoryName] = [];
                }

                categoryMap[categoryName].push({
                    id: String(item.name || ''),
                    title: item.name || '未知分类',
                    platform: PLATFORM_NAME,
                });
            }

            // 转换为分组格式，按分类名称排序
            const sortedCategories = Object.keys(categoryMap).sort();
            for (const categoryName of sortedCategories) {
                const tags = categoryMap[categoryName];
                if (tags && tags.length > 0) {
                    categoryGroups.push({
                        title: categoryName,
                        data: tags,
                    });
                }
            }

            return {
                pinned: pinned.length > 0 ? pinned : undefined,
                data: categoryGroups,
            };
        } catch (error) {
            console.error('获取推荐歌单分类失败:', error);
            // 返回默认分类作为备用
            return {
                pinned: [
                    {id: '推荐', title: '推荐', platform: PLATFORM_NAME},
                    {id: '全部', title: '全部', platform: PLATFORM_NAME},
                    {id: '华语', title: '华语', platform: PLATFORM_NAME},
                    {id: '欧美', title: '欧美', platform: PLATFORM_NAME},
                    {id: '日韩', title: '日韩', platform: PLATFORM_NAME},
                ],
                data: [
                    {
                        title: '语种',
                        data: [
                            {
                                id: '华语',
                                title: '华语',
                                platform: PLATFORM_NAME,
                            },
                            {
                                id: '欧美',
                                title: '欧美',
                                platform: PLATFORM_NAME,
                            },
                            {
                                id: '日韩',
                                title: '日韩',
                                platform: PLATFORM_NAME,
                            },
                            {
                                id: '粤语',
                                title: '粤语',
                                platform: PLATFORM_NAME,
                            },
                            {
                                id: '小语种',
                                title: '小语种',
                                platform: PLATFORM_NAME,
                            },
                        ],
                    },
                    {
                        title: '风格',
                        data: [
                            {
                                id: '流行',
                                title: '流行',
                                platform: PLATFORM_NAME,
                            },
                            {
                                id: '摇滚',
                                title: '摇滚',
                                platform: PLATFORM_NAME,
                            },
                            {
                                id: '民谣',
                                title: '民谣',
                                platform: PLATFORM_NAME,
                            },
                            {
                                id: '电子',
                                title: '电子',
                                platform: PLATFORM_NAME,
                            },
                            {
                                id: '说唱',
                                title: '说唱',
                                platform: PLATFORM_NAME,
                            },
                            {id: 'R&B', title: 'R&B', platform: PLATFORM_NAME},
                            {
                                id: '爵士',
                                title: '爵士',
                                platform: PLATFORM_NAME,
                            },
                            {
                                id: '古典',
                                title: '古典',
                                platform: PLATFORM_NAME,
                            },
                            {
                                id: '轻音乐',
                                title: '轻音乐',
                                platform: PLATFORM_NAME,
                            },
                        ],
                    },
                    {
                        title: '场景',
                        data: [
                            {
                                id: '运动',
                                title: '运动',
                                platform: PLATFORM_NAME,
                            },
                            {
                                id: '学习',
                                title: '学习',
                                platform: PLATFORM_NAME,
                            },
                            {
                                id: '工作',
                                title: '工作',
                                platform: PLATFORM_NAME,
                            },
                            {
                                id: '休息',
                                title: '休息',
                                platform: PLATFORM_NAME,
                            },
                            {
                                id: '旅行',
                                title: '旅行',
                                platform: PLATFORM_NAME,
                            },
                            {
                                id: '睡前',
                                title: '睡前',
                                platform: PLATFORM_NAME,
                            },
                        ],
                    },
                    {
                        title: '情感',
                        data: [
                            {
                                id: '怀旧',
                                title: '怀旧',
                                platform: PLATFORM_NAME,
                            },
                            {
                                id: '治愈',
                                title: '治愈',
                                platform: PLATFORM_NAME,
                            },
                            {
                                id: '兴奋',
                                title: '兴奋',
                                platform: PLATFORM_NAME,
                            },
                            {
                                id: '安静',
                                title: '安静',
                                platform: PLATFORM_NAME,
                            },
                            {
                                id: '伤感',
                                title: '伤感',
                                platform: PLATFORM_NAME,
                            },
                        ],
                    },
                ],
            };
        }
    },

    /**
     * 根据标签获取推荐歌单
     * @param {Object} tagItem - 标签项
     * @param {number} page - 页码，从1开始
     */
    async getRecommendSheetsByTag(tagItem, page = 1) {
        try {
            const tagName = tagItem.id || tagItem.title || '全部';
            const limit = 20;
            const offset = (page - 1) * limit;

            let response;
            let playlists = [];
            let total = 0;

            // 如果是"推荐"，使用专门的推荐歌单API
            if (tagName === '推荐' || tagName === '热门推荐') {
                try {
                    // 方案1: 使用个性化推荐API
                    response = await fetchWithRetry(
                        `${API_BASE_URL}/api/personalized/playlist?limit=${limit}&offset=${offset}`,
                        {
                            method: 'GET',
                            headers: {
                                'User-Agent': COMMON_HEADERS['User-Agent'],
                                Referer: COMMON_HEADERS['Referer'],
                            },
                        },
                        2,
                        8000,
                    );

                    if (response.result && Array.isArray(response.result)) {
                        playlists = response.result;
                        total = response.result.length;
                    }
                } catch (error) {
                    console.log(
                        '个性化推荐API失败，尝试热门歌单API:',
                        error.message,
                    );
                }

                // 方案2: 如果个性化推荐失败，使用热门歌单API
                if (playlists.length === 0) {
                    try {
                        response = await fetchWithRetry(
                            `${API_BASE_URL}/api/top/playlist/highquality?limit=${limit}&offset=${offset}`,
                            {
                                method: 'GET',
                                headers: {
                                    'User-Agent': COMMON_HEADERS['User-Agent'],
                                    Referer: COMMON_HEADERS['Referer'],
                                },
                            },
                            2,
                            8000,
                        );

                        if (
                            response.playlists &&
                            Array.isArray(response.playlists)
                        ) {
                            playlists = response.playlists;
                            total = response.total || response.playlists.length;
                        }
                    } catch (error) {
                        console.log(
                            '热门歌单API失败，使用分类API:',
                            error.message,
                        );
                    }
                }

                // 方案3: 如果都失败，使用"全部"分类的热门歌单
                if (playlists.length === 0) {
                    response = await fetchWithRetry(
                        `${API_BASE_URL}/api/playlist/list?cat=全部&order=hot&limit=${limit}&offset=${offset}&total=true`,
                        {
                            method: 'GET',
                            headers: {
                                'User-Agent': COMMON_HEADERS['User-Agent'],
                                Referer: COMMON_HEADERS['Referer'],
                            },
                        },
                        2,
                        8000,
                    );

                    playlists = response.playlists || [];
                    total = response.total || 0;
                }
            } else {
                // 其他分类，使用分类API
                response = await fetchWithRetry(
                    `${API_BASE_URL}/api/playlist/list?cat=${encodeURIComponent(
                        tagName,
                    )}&order=hot&limit=${limit}&offset=${offset}&total=true`,
                    {
                        method: 'GET',
                        headers: buildHeaders(),
                    },
                    2,
                    8000,
                );

                playlists = response.playlists || [];
                total = response.total || 0;
            }

            return {
                isEnd: calculateIsEnd(total, page, limit, playlists.length),
                data: playlists.map(playlist => ({
                    id: String(playlist.id || ''),
                    title: playlist.name || '未知歌单',
                    description: playlist.description || '',
                    coverImg: playlist.coverImgUrl || playlist.picUrl || '',
                    artwork: playlist.coverImgUrl || playlist.picUrl || '',
                    artist: playlist.creator?.nickname || '未知用户',
                    playCount: playlist.playCount || 0,
                    worksNum: playlist.trackCount || 0,
                    platform: PLATFORM_NAME,
                })),
            };
        } catch (error) {
            console.error('获取推荐歌单失败:', error);
            return {
                isEnd: true,
                data: [],
            };
        }
    },

    /**
     * 获取艺术家作品列表
     * @param {Object} artistItem - 艺术家项
     * @param {number} page - 页码，从1开始
     * @param {string} type - 作品类型：'music' 或 'album'
     */
    async getArtistWorks(artistItem, page, type) {
        try {
            const artistId = String(artistItem.id || '');
            if (!artistId) {
                throw new Error('无效的艺术家ID');
            }

            const limit = 20;
            const offset = (page - 1) * limit;

            if (type === 'music') {
                // 获取艺术家的歌曲
                const response = await fetchWithRetry(
                    `${API_BASE_URL}/api/artist/songs?id=${artistId}&limit=${limit}&offset=${offset}`,
                    {
                        method: 'GET',
                        headers: buildHeaders(),
                    },
                    2,
                    8000,
                );

                const songs = response.songs || [];
                const total = response.total || songs.length;

                return {
                    isEnd: calculateIsEnd(total, page, limit, songs.length),
                    data: songs
                        .map(song => normalizeMusicItem(song))
                        .filter(Boolean),
                };
            } else if (type === 'album') {
                // 获取艺术家的专辑
                const response = await fetchWithRetry(
                    `${API_BASE_URL}/api/artist/album?id=${artistId}&limit=${limit}&offset=${offset}`,
                    {
                        method: 'GET',
                        headers: buildHeaders(),
                    },
                    2,
                    8000,
                );

                const albums = response.hotAlbums || [];
                const total = response.artist?.albumSize || albums.length;

                return {
                    isEnd: calculateIsEnd(total, page, limit, albums.length),
                    data: albums
                        .map(album => normalizeAlbumItem(album))
                        .filter(Boolean),
                };
            }

            return {
                isEnd: true,
                data: [],
            };
        } catch (error) {
            console.error('获取艺术家作品失败:', error);
            return {
                isEnd: true,
                data: [],
            };
        }
    },
};
