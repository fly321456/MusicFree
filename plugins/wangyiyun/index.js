/**
 * 网易云音乐 MusicFree 插件
 * 支持搜索、播放、歌单导入和榜单功能
 */

// 通用请求头
const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://music.163.com/',
  'Content-Type': 'application/json'
};

// 请求重试函数
async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) {
        return await response.json();
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (error) {
      lastError = error;
      if (i < maxRetries - 1) {
        // 等待后重试，指数退避
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
      }
    }
  }
  throw lastError;
}

// 解析歌单ID
function parsePlaylistId(urlLike) {
  if (!urlLike) return null;
  
  const regexes = [
    /music\.163\.com.*playlist\?id=(\d+)/,
    /music\.163\.com.*playlist\/(\d+)/,
    /playlist\?id=(\d+)/,
    /playlist\/(\d+)/
  ];
  
  for (const regex of regexes) {
    const match = urlLike.match(regex);
    if (match) return match[1];
  }
  
  // 如果输入的不是链接，则认为是直接输入的歌单ID
  if (/^\d+$/.test(urlLike.trim())) {
    return urlLike.trim();
  }
  
  return null;
}

// 将歌曲数据标准化
function normalizeMusicItem(song) {
  // duration 需要转换为秒（网易云返回的是毫秒）
  const duration = song.dt || song.duration || 0;
  const durationInSeconds = typeof duration === 'number' ? Math.floor(duration / 1000) : 0;
  
  return {
    id: String(song.id || ''), // 确保 id 是字符串类型
    title: song.name || song.title || '未知歌曲',
    artist: (song.ar || song.artists || []).map(artist => artist.name).join('/') || '未知艺术家',
    album: (song.al || song.album)?.name || '未知专辑',
    duration: durationInSeconds, // 转换为秒
    artwork: (song.al || song.album)?.picUrl || (song.al || song.album)?.pic || '',
    platform: '网易云音乐'
  };
}

module.exports = {
  platform: "网易云音乐",
  version: "1.0.0",
  author: "MusicFree Plugin",
  // appVersion: ">=0.8.0", // 已移除版本限制，确保兼容性
  description: "网易云音乐插件，支持搜索、播放、歌单导入和榜单功能",
  
  // 定义插件支持的搜索类型
  supportedSearchType: ['music', 'album', 'artist', 'sheet'],
  
  // 缓存控制策略
  cacheControl: 'cache',
  
  // 提示信息
  hints: {
    importMusicSheet: [
      "网易云移动端：APP点击分享，然后复制链接",
      "网易云H5/PC端：复制URL，或者直接输入歌单ID即可",
      "默认歌单无法导入，先新建一个空白歌单复制过去再导入新歌单即可"
    ]
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
          data: []
        };
      }

      const searchTypeMap = {
        'music': 1,     // 单曲
        'album': 10,    // 专辑
        'artist': 100,  // 歌手
        'sheet': 1000   // 歌单
      };

      const searchType = searchTypeMap[type] || 1;
      const limit = 20;
      const offset = (page - 1) * limit;

      let response;
      let result = {};

      // 方案1: 尝试使用 cloudsearch/pc API
      try {
        response = await fetchWithRetry('https://music.163.com/api/cloudsearch/pc', {
          method: 'POST',
          headers: {
            'User-Agent': COMMON_HEADERS['User-Agent'],
            'Referer': COMMON_HEADERS['Referer'],
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            s: query.trim(),
            type: searchType,
            limit: limit,
            offset: offset
          })
        }, 2);

        if (response && response.result) {
          result = response.result;
        } else if (response && response.code === 200 && response.result) {
          result = response.result;
        }
      } catch (error) {
        console.log('cloudsearch/pc API 失败，尝试备用方案:', error.message);
      }

      // 方案2: 如果第一个API失败，尝试使用搜索建议API作为备用
      if (!result || Object.keys(result).length === 0) {
        try {
          // 使用搜索建议API获取部分结果
          const suggestResponse = await fetchWithRetry(
            `https://music.163.com/api/search/suggest/web?keywords=${encodeURIComponent(query.trim())}&type=${searchType}`,
            {
              method: 'GET',
              headers: {
                'User-Agent': COMMON_HEADERS['User-Agent'],
                'Referer': COMMON_HEADERS['Referer']
              }
            },
            1
          );

          if (suggestResponse && suggestResponse.result) {
            // 将建议结果转换为搜索结果格式
            if (type === 'music' && suggestResponse.result.songs) {
              result.songs = suggestResponse.result.songs.slice(0, limit);
              result.songCount = suggestResponse.result.songs.length;
            } else if (type === 'album' && suggestResponse.result.albums) {
              result.albums = suggestResponse.result.albums.slice(0, limit);
              result.albumCount = suggestResponse.result.albums.length;
            } else if (type === 'artist' && suggestResponse.result.artists) {
              result.artists = suggestResponse.result.artists.slice(0, limit);
              result.artistCount = suggestResponse.result.artists.length;
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
          isEnd: songCount <= (page * limit) || songs.length < limit,
          data: songs.map(song => normalizeMusicItem(song))
        };
      } else if (type === 'album') {
        const albums = result.albums || [];
        const albumCount = result.albumCount || albums.length;
        
        return {
          isEnd: albumCount <= (page * limit) || albums.length < limit,
          data: albums.map(album => ({
            id: String(album.id || ''),
            title: album.name || '未知专辑',
            artist: (album.artist || {}).name || '未知艺术家',
            artwork: album.picUrl || album.pic || '',
            description: album.description || '',
            platform: '网易云音乐'
          }))
        };
      } else if (type === 'artist') {
        const artists = result.artists || [];
        const artistCount = result.artistCount || artists.length;
        
        return {
          isEnd: artistCount <= (page * limit) || artists.length < limit,
          data: artists.map(artist => ({
            id: String(artist.id || ''),
            name: artist.name || '未知艺术家',
            avatar: artist.picUrl || artist.pic || '',
            description: artist.briefDesc || '',
            platform: '网易云音乐'
          }))
        };
      } else if (type === 'sheet') {
        const playlists = result.playlists || [];
        const playlistCount = result.playlistCount || playlists.length;
        
        return {
          isEnd: playlistCount <= (page * limit) || playlists.length < limit,
          data: playlists.map(playlist => ({
            id: String(playlist.id || ''),
            title: playlist.name || '未知歌单',
            description: playlist.description || '',
            coverImg: playlist.coverImgUrl || playlist.picUrl || '',
            playCount: playlist.playCount || 0,
            platform: '网易云音乐'
          }))
        };
      }

      return {
        isEnd: true,
        data: []
      };
    } catch (error) {
      console.error('搜索失败:', {
        query: query,
        type: type,
        page: page,
        error: error.message
      });
      return {
        isEnd: true,
        data: []
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
      
      // 使用网易云音乐的歌曲URL API
      // 音质映射：网易云使用 br 参数，128000=standard, 192000=high, 320000=super, 999000=lossless
      const qualityMap = {
        'low': 128000,
        'standard': 128000,
        'high': 192000,
        'super': 320000
      };
      
      const br = qualityMap[quality] || qualityMap['standard'];
      
      // 获取歌曲播放URL
      let audioUrl = null;
      let lastError = null;
      
      // 方案1: 尝试新的API端点 v1
      try {
        const response = await fetchWithRetry(
          `https://music.163.com/api/song/url/v1?id=${songId}&level=exhigh&encodeType=mp3`,
          {
            method: 'GET',
            headers: {
              'User-Agent': COMMON_HEADERS['User-Agent'],
              'Referer': COMMON_HEADERS['Referer']
            }
          },
          2 // 减少重试次数，快速失败
        );

        if (response.data && response.data.length > 0) {
          const urlData = response.data[0];
          if (urlData.url && urlData.url.trim() && urlData.url !== 'null') {
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
            `https://music.163.com/api/song/enhance/player/url?ids=[${songId}]&br=${br}`,
            {
              method: 'GET',
              headers: {
                'User-Agent': COMMON_HEADERS['User-Agent'],
                'Referer': COMMON_HEADERS['Referer']
              }
            },
            2
          );
          
          if (oldResponse.data && oldResponse.data.length > 0) {
            const urlData = oldResponse.data[0];
            if (urlData.url && urlData.url.trim() && urlData.url !== 'null') {
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
            `https://music.163.com/api/song/url?id=${songId}&ids=[${songId}]&br=${br}`,
            {
              method: 'GET',
              headers: {
                'User-Agent': COMMON_HEADERS['User-Agent'],
                'Referer': COMMON_HEADERS['Referer']
              }
            },
            1 // 只重试1次
          );
          
          if (altResponse.data && altResponse.data.length > 0) {
            const urlData = altResponse.data[0];
            if (urlData.url && urlData.url.trim() && urlData.url !== 'null') {
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
      if (!audioUrl || !audioUrl.trim() || audioUrl === 'null' || audioUrl === 'undefined') {
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
          'Referer': COMMON_HEADERS['Referer']
        }
      };
    } catch (error) {
      console.error('获取媒体源失败:', {
        songId: musicItem?.id,
        title: musicItem?.title,
        error: error.message
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
        `https://music.163.com/api/song/lyric?id=${songId}&lv=-1&tv=-1`,
        {
          method: 'GET',
          headers: {
            'User-Agent': COMMON_HEADERS['User-Agent'],
            'Referer': COMMON_HEADERS['Referer']
          }
        }
      );

      // 提取歌词和翻译
      const lrc = response.lrc?.lyric || '';
      const tlyric = response.tlyric?.lyric || '';

      if (!lrc && !tlyric) {
        return null;
      }

      return {
        rawLrc: lrc || undefined,
        translation: tlyric || undefined
      };
    } catch (error) {
      console.error('获取歌词失败:', error);
      return null;
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
        throw new Error("无效的歌单链接或ID");
      }

      // 方案1: 尝试使用 v3 API 获取歌单详情（支持更多歌曲）
      let response;
      try {
        response = await fetchWithRetry(
          `https://music.163.com/api/v3/playlist/detail?id=${playlistId}&n=5000`,
          {
            method: 'GET',
            headers: {
              'User-Agent': COMMON_HEADERS['User-Agent'],
              'Referer': 'https://y.music.163.com/',
              'Origin': 'https://y.music.163.com/'
            }
          }
        );

        // v3 API 返回 trackIds，需要分批获取歌曲详情
        if (response.playlist && response.playlist.trackIds) {
          const trackIds = response.playlist.trackIds.map(item => item.id);
          const allTracks = [];

          // 分批获取歌曲详情（每批200首）
          const batchSize = 200;
          for (let i = 0; i < trackIds.length; i += batchSize) {
            const batch = trackIds.slice(i, i + batchSize);
            try {
              const songsResponse = await fetchWithRetry(
                `https://music.163.com/api/song/detail/?ids=[${batch.join(',')}]`,
                {
                  method: 'GET',
                  headers: {
                    'User-Agent': COMMON_HEADERS['User-Agent'],
                    'Referer': 'https://y.music.163.com/',
                    'Origin': 'https://y.music.163.com/'
                  }
                }
              );

              if (songsResponse.songs && songsResponse.songs.length > 0) {
                allTracks.push(...songsResponse.songs);
              }
            } catch (batchError) {
              console.log(`获取第 ${Math.floor(i / batchSize) + 1} 批歌曲失败:`, batchError.message);
            }
          }

          if (allTracks.length > 0) {
            return allTracks.map(track => normalizeMusicItem(track));
          }
        }
      } catch (v3Error) {
        console.log('v3 API 失败，尝试旧版 API:', v3Error.message);
      }

      // 方案2: 如果 v3 API 失败，尝试旧版 API
      response = await fetchWithRetry(
        `https://music.163.com/api/playlist/detail?id=${playlistId}`,
        {
          method: 'GET',
          headers: {
            'User-Agent': COMMON_HEADERS['User-Agent'],
            'Referer': COMMON_HEADERS['Referer']
          }
        }
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
      return tracks.map(track => normalizeMusicItem(track));
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
        'https://music.163.com/api/toplist',
        {
          method: 'GET',
          headers: {
            'User-Agent': COMMON_HEADERS['User-Agent'],
            'Referer': COMMON_HEADERS['Referer']
          }
        }
      );

      const list = response.list || [];
      
      return list.map(item => ({
        title: item.name || '未知榜单',
        data: (item.list || []).map(listItem => ({
          id: String(listItem.id || ''),
          title: listItem.name || listItem.title || '未知榜单',
          description: listItem.description || `更新频率：${listItem.updateFrequency || '未知'}`,
          coverImg: listItem.coverImgUrl || listItem.picUrl || '',
          playCount: listItem.playCount || 0,
          // 额外信息，用于后续获取详情
          extra: {
            source: 'netease',
            topId: String(listItem.id || '')
          },
          platform: '网易云音乐'
        }))
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
      const topId = String(topListItem.extra?.topId || topListItem.id || '');
      if (!topId) {
        throw new Error('无效的榜单ID');
      }

      const response = await fetchWithRetry(
        `https://music.163.com/api/toplist/detail?id=${topId}`,
        {
          method: 'GET',
          headers: {
            'User-Agent': COMMON_HEADERS['User-Agent'],
            'Referer': COMMON_HEADERS['Referer']
          }
        }
      );

      const playlist = response.playlist || {};
      const tracks = playlist.tracks || [];
      
      return {
        topListItem: topListItem,
        musicList: tracks.map(song => normalizeMusicItem(song)),
        isEnd: true // 榜单通常一次获取全部，无分页
      };
    } catch (error) {
      console.error('获取榜单详情失败:', error);
      return {
        topListItem: topListItem,
        musicList: [],
        isEnd: true
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
        'https://music.163.com/api/playlist/catlist',
        {
          method: 'GET',
          headers: {
            'User-Agent': COMMON_HEADERS['User-Agent'],
            'Referer': COMMON_HEADERS['Referer']
          }
        }
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
        platform: '网易云音乐'
      });

      // 处理热门分类（置顶）- 添加"全部"和热门分类
      if (all.name) {
        pinned.push({
          id: '全部',
          title: all.name,
          platform: '网易云音乐'
        });
      }

      // 添加热门分类到置顶（华语、欧美、日韩、粤语等）
      const hotCategories = ['华语', '欧美', '日韩', '粤语', '流行', '摇滚', '民谣', '电子', '说唱', 'R&B', '爵士', '古典', '轻音乐'];
      const hotSubItems = sub.filter(item => hotCategories.includes(item.name));
      for (const item of hotSubItems) {
        pinned.push({
          id: String(item.name || ''),
          title: item.name || '未知分类',
          platform: '网易云音乐'
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
          platform: '网易云音乐'
        });
      }

      // 转换为分组格式，按分类名称排序
      const sortedCategories = Object.keys(categoryMap).sort();
      for (const categoryName of sortedCategories) {
        const tags = categoryMap[categoryName];
        if (tags && tags.length > 0) {
          categoryGroups.push({
            title: categoryName,
            data: tags
          });
        }
      }

      return {
        pinned: pinned.length > 0 ? pinned : undefined,
        data: categoryGroups
      };
    } catch (error) {
      console.error('获取推荐歌单分类失败:', error);
      // 返回默认分类作为备用
      return {
        pinned: [
          { id: '推荐', title: '推荐', platform: '网易云音乐' },
          { id: '全部', title: '全部', platform: '网易云音乐' },
          { id: '华语', title: '华语', platform: '网易云音乐' },
          { id: '欧美', title: '欧美', platform: '网易云音乐' },
          { id: '日韩', title: '日韩', platform: '网易云音乐' }
        ],
        data: [
          {
            title: '语种',
            data: [
              { id: '华语', title: '华语', platform: '网易云音乐' },
              { id: '欧美', title: '欧美', platform: '网易云音乐' },
              { id: '日韩', title: '日韩', platform: '网易云音乐' },
              { id: '粤语', title: '粤语', platform: '网易云音乐' },
              { id: '小语种', title: '小语种', platform: '网易云音乐' }
            ]
          },
          {
            title: '风格',
            data: [
              { id: '流行', title: '流行', platform: '网易云音乐' },
              { id: '摇滚', title: '摇滚', platform: '网易云音乐' },
              { id: '民谣', title: '民谣', platform: '网易云音乐' },
              { id: '电子', title: '电子', platform: '网易云音乐' },
              { id: '说唱', title: '说唱', platform: '网易云音乐' },
              { id: 'R&B', title: 'R&B', platform: '网易云音乐' },
              { id: '爵士', title: '爵士', platform: '网易云音乐' },
              { id: '古典', title: '古典', platform: '网易云音乐' },
              { id: '轻音乐', title: '轻音乐', platform: '网易云音乐' }
            ]
          },
          {
            title: '场景',
            data: [
              { id: '运动', title: '运动', platform: '网易云音乐' },
              { id: '学习', title: '学习', platform: '网易云音乐' },
              { id: '工作', title: '工作', platform: '网易云音乐' },
              { id: '休息', title: '休息', platform: '网易云音乐' },
              { id: '旅行', title: '旅行', platform: '网易云音乐' },
              { id: '睡前', title: '睡前', platform: '网易云音乐' }
            ]
          },
          {
            title: '情感',
            data: [
              { id: '怀旧', title: '怀旧', platform: '网易云音乐' },
              { id: '治愈', title: '治愈', platform: '网易云音乐' },
              { id: '兴奋', title: '兴奋', platform: '网易云音乐' },
              { id: '安静', title: '安静', platform: '网易云音乐' },
              { id: '伤感', title: '伤感', platform: '网易云音乐' }
            ]
          }
        ]
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
            `https://music.163.com/api/personalized/playlist?limit=${limit}&offset=${offset}`,
            {
              method: 'GET',
              headers: {
                'User-Agent': COMMON_HEADERS['User-Agent'],
                'Referer': COMMON_HEADERS['Referer']
              }
            }
          );

          if (response.result && Array.isArray(response.result)) {
            playlists = response.result;
            total = response.result.length;
          }
        } catch (error) {
          console.log('个性化推荐API失败，尝试热门歌单API:', error.message);
        }

        // 方案2: 如果个性化推荐失败，使用热门歌单API
        if (playlists.length === 0) {
          try {
            response = await fetchWithRetry(
              `https://music.163.com/api/top/playlist/highquality?limit=${limit}&offset=${offset}`,
              {
                method: 'GET',
                headers: {
                  'User-Agent': COMMON_HEADERS['User-Agent'],
                  'Referer': COMMON_HEADERS['Referer']
                }
              }
            );

            if (response.playlists && Array.isArray(response.playlists)) {
              playlists = response.playlists;
              total = response.total || response.playlists.length;
            }
          } catch (error) {
            console.log('热门歌单API失败，使用分类API:', error.message);
          }
        }

        // 方案3: 如果都失败，使用"全部"分类的热门歌单
        if (playlists.length === 0) {
          response = await fetchWithRetry(
            `https://music.163.com/api/playlist/list?cat=全部&order=hot&limit=${limit}&offset=${offset}&total=true`,
            {
              method: 'GET',
              headers: {
                'User-Agent': COMMON_HEADERS['User-Agent'],
                'Referer': COMMON_HEADERS['Referer']
              }
            }
          );

          playlists = response.playlists || [];
          total = response.total || 0;
        }
      } else {
        // 其他分类，使用分类API
        response = await fetchWithRetry(
          `https://music.163.com/api/playlist/list?cat=${encodeURIComponent(tagName)}&order=hot&limit=${limit}&offset=${offset}&total=true`,
          {
            method: 'GET',
            headers: {
              'User-Agent': COMMON_HEADERS['User-Agent'],
              'Referer': COMMON_HEADERS['Referer']
            }
          }
        );

        playlists = response.playlists || [];
        total = response.total || 0;
      }

      return {
        isEnd: total <= (page * limit) || playlists.length < limit,
        data: playlists.map(playlist => ({
          id: String(playlist.id || ''),
          title: playlist.name || '未知歌单',
          description: playlist.description || '',
          coverImg: playlist.coverImgUrl || playlist.picUrl || '',
          artwork: playlist.coverImgUrl || playlist.picUrl || '',
          artist: playlist.creator?.nickname || '未知用户',
          playCount: playlist.playCount || 0,
          worksNum: playlist.trackCount || 0,
          platform: '网易云音乐'
        }))
      };
    } catch (error) {
      console.error('获取推荐歌单失败:', error);
      return {
        isEnd: true,
        data: []
      };
    }
  }
};

