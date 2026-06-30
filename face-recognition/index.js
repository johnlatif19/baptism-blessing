const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

class FaceRecognition {
    constructor() {
        this.embeddingsFile = path.join(__dirname, 'embeddings', 'gallery_embeddings.json');
        this.pythonPath = process.env.PYTHON_PATH || 'python3';
        this.threshold = parseFloat(process.env.FACE_RECOGNITION_THRESHOLD) || 0.6;
        this.model = process.env.FACE_RECOGNITION_MODEL || 'buffalo_l';
        this.tempDir = path.join(__dirname, '..', 'uploads', 'temp');
        
        // إنشاء المجلدات المؤقتة
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    /**
     * استخراج Embedding من صورة واحدة
     */
    async extractFaceEmbedding(imageBuffer) {
        return new Promise((resolve, reject) => {
            // حفظ الصورة مؤقتاً
            const tempId = crypto.randomBytes(16).toString('hex');
            const tempPath = path.join(this.tempDir, `${tempId}.jpg`);
            
            try {
                fs.writeFileSync(tempPath, imageBuffer);
            } catch (err) {
                reject(new Error(`Failed to save temp image: ${err.message}`));
                return;
            }

            // تشغيل سكريبت Python لاستخراج الـ Embedding
            const pythonScript = path.join(__dirname, 'extract_single_face.py');
            const pythonProcess = spawn(this.pythonPath, [pythonScript, tempPath]);

            let stdout = '';
            let stderr = '';

            pythonProcess.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            pythonProcess.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            pythonProcess.on('close', (code) => {
                // حذف الملف المؤقت
                try {
                    fs.unlinkSync(tempPath);
                } catch (err) {
                    console.warn('Could not delete temp file:', err);
                }

                if (code !== 0) {
                    reject(new Error(`Python script failed: ${stderr || stdout}`));
                    return;
                }

                try {
                    const result = JSON.parse(stdout);
                    if (result.error) {
                        reject(new Error(result.error));
                    } else if (!result.embedding) {
                        reject(new Error('No face detected in the image'));
                    } else {
                        resolve(result);
                    }
                } catch (err) {
                    reject(new Error(`Failed to parse Python output: ${err.message}`));
                }
            });
        });
    }

    /**
     * البحث عن صور مطابقة في قاعدة البيانات
     */
    async findMatchingPhotos(embedding) {
        return new Promise((resolve, reject) => {
            // التحقق من وجود قاعدة البيانات
            if (!fs.existsSync(this.embeddingsFile)) {
                reject(new Error('Gallery embeddings database not found. Please run extract_embeddings first.'));
                return;
            }

            // إعداد البيانات للإرسال إلى Python
            const inputData = {
                embedding: embedding,
                threshold: this.threshold
            };

            // تشغيل سكريبت البحث
            const pythonScript = path.join(__dirname, 'find_faces.py');
            const pythonProcess = spawn(this.pythonPath, [pythonScript]);

            let stdout = '';
            let stderr = '';

            pythonProcess.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            pythonProcess.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            pythonProcess.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`Python script failed: ${stderr || stdout}`));
                    return;
                }

                try {
                    const result = JSON.parse(stdout);
                    resolve(result);
                } catch (err) {
                    reject(new Error(`Failed to parse Python output: ${err.message}`));
                }
            });

            // إرسال البيانات إلى stdin
            pythonProcess.stdin.write(JSON.stringify(inputData));
            pythonProcess.stdin.end();
        });
    }

    /**
     * استخراج Embeddings من جميع صور المعرض
     */
    async extractAllGalleryEmbeddings(imagesData) {
        return new Promise((resolve, reject) => {
            // حفظ بيانات الصور في ملف مؤقت
            const tempId = crypto.randomBytes(16).toString('hex');
            const tempFile = path.join(this.tempDir, `${tempId}.json`);
            
            try {
                fs.writeFileSync(tempFile, JSON.stringify(imagesData));
            } catch (err) {
                reject(new Error(`Failed to save images data: ${err.message}`));
                return;
            }

            // تشغيل سكريبت الاستخراج
            const pythonScript = path.join(__dirname, 'extract_embeddings.py');
            const pythonProcess = spawn(this.pythonPath, [
                pythonScript,
                '--input', tempFile,
                '--threshold', this.threshold.toString(),
                '--model', this.model
            ]);

            let stdout = '';
            let stderr = '';

            pythonProcess.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            pythonProcess.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            pythonProcess.on('close', (code) => {
                // حذف الملف المؤقت
                try {
                    fs.unlinkSync(tempFile);
                } catch (err) {
                    console.warn('Could not delete temp file:', err);
                }

                if (code !== 0) {
                    reject(new Error(`Python script failed: ${stderr || stdout}`));
                    return;
                }

                resolve({ success: true, output: stdout });
            });
        });
    }

    /**
     * التحقق من وجود قاعدة بيانات Embeddings
     */
    hasEmbeddingsDatabase() {
        return fs.existsSync(this.embeddingsFile);
    }

    /**
     * الحصول على معلومات قاعدة البيانات
     */
    getDatabaseInfo() {
        if (!this.hasEmbeddingsDatabase()) {
            return null;
        }
        
        try {
            const data = JSON.parse(fs.readFileSync(this.embeddingsFile, 'utf8'));
            return {
                total_images: data.metadata?.processed_images || 0,
                total_faces: data.metadata?.total_faces || 0,
                created_at: data.metadata?.created_at || 'Unknown',
                model: data.metadata?.model || 'Unknown'
            };
        } catch (err) {
            return null;
        }
    }
}

module.exports = FaceRecognition;
