import multer from 'multer';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import os from 'os';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Upload directories
const uploadDir = path.join(__dirname, '../public/uploads/instructions');
const videoUploadDir = path.join(__dirname, '../public/uploads/videos');

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
if (!fs.existsSync(videoUploadDir)) {
    fs.mkdirSync(videoUploadDir, { recursive: true });
}

// Multer configuration - store in memory
const storage = multer.memoryStorage();

// File filter - accept images AND videos
const fileFilter = (req, file, cb) => {
    const allowedTypes = [
        'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif',
        'video/mp4', 'video/quicktime', 'video/webm', 'video/mkv', 'video/x-matroska', 'video/avi', 'video/3gpp'
    ];
    const isAllowedExt = file.originalname && file.originalname.match(/\.(jpg|jpeg|png|webp|gif|mp4|mov|webm|mkv|avi|3gp)$/i);
    
    if (allowedTypes.includes(file.mimetype) || isAllowedExt) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only images (JPEG, PNG, WebP) and videos (MP4, MOV, WebM) are allowed.'), false);
    }
};

// Multer upload instance - 60MB max
export const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 60 * 1024 * 1024 // 60MB max
    }
});

// Compress and save media (Image or Video)
export const compressAndSaveImage = async (fileOrBuffer, originalname = '') => {
    try {
        let buffer = fileOrBuffer;
        let name = originalname;
        let mime = '';

        if (fileOrBuffer && fileOrBuffer.buffer) {
            buffer = fileOrBuffer.buffer;
            name = fileOrBuffer.originalname || originalname;
            mime = fileOrBuffer.mimetype || '';
        }

        // Ensure buffer is a Node.js Buffer
        let nodeBuffer;
        if (Buffer.isBuffer(buffer)) {
            nodeBuffer = buffer;
        } else if (buffer instanceof ArrayBuffer || ArrayBuffer.isView(buffer)) {
            nodeBuffer = Buffer.from(buffer);
        } else if (typeof buffer === 'string') {
            nodeBuffer = Buffer.from(buffer);
        } else {
            nodeBuffer = Buffer.from(buffer);
        }

        const isVideo = (mime && mime.startsWith('video/')) || (name && name.match(/\.(mp4|mov|webm|mkv|avi|3gp)$/i));

        const timestamp = Date.now();
        const randomString = Math.random().toString(36).substring(7);

        if (isVideo) {
            console.log(`🎬 [Video Compression] Processing video ${name}...`);
            const inputTemp = path.join(os.tmpdir(), `raw_vid_${timestamp}_${randomString}.mp4`);
            const outputFilename = `vid_${timestamp}_${randomString}.mp4`;
            const outputPath = path.join(videoUploadDir, outputFilename);

            fs.writeFileSync(inputTemp, nodeBuffer);

            await new Promise((resolve) => {
                ffmpeg(inputTemp)
                    .videoCodec('libx264')
                    .audioCodec('aac')
                    .outputOptions([
                        '-preset fast',
                        '-crf 26',
                        "-vf scale='min(720,iw)':-2",
                        '-r 30',
                        '-movflags +faststart'
                    ])
                    .on('end', () => {
                        console.log(`✅ [Video Compression] Video compressed and saved: ${outputFilename}`);
                        resolve();
                    })
                    .on('error', (err) => {
                        console.error('❌ [Video Compression Error, saving original]:', err);
                        // Fallback: save original buffer if ffmpeg fails
                        fs.writeFileSync(outputPath, nodeBuffer);
                        resolve();
                    })
                    .save(outputPath);
            });

            if (fs.existsSync(inputTemp)) {
                try { fs.unlinkSync(inputTemp); } catch (e) {}
            }

            return `/uploads/videos/${outputFilename}`;
        } else {
            // Compress Image using Sharp
            const filename = `instruction_${timestamp}_${randomString}.jpg`;
            const filepath = path.join(uploadDir, filename);

            await sharp(nodeBuffer)
                .resize(1200, 1200, {
                    fit: 'inside',
                    withoutEnlargement: true
                })
                .jpeg({ quality: 80 })
                .toFile(filepath);

            return `/uploads/instructions/${filename}`;
        }
    } catch (error) {
        console.error('Media compression error:', error);
        throw new Error('Failed to compress and save media');
    }
};

// Delete media file
export const deleteImage = (mediaUrl) => {
    try {
        if (!mediaUrl) return;
        const filepath = path.join(process.cwd(), 'public', mediaUrl);
        if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
            console.log(`✅ Deleted media: ${mediaUrl}`);
        }
    } catch (error) {
        console.error('Media deletion error:', error);
    }
};

