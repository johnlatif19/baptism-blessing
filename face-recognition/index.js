const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class FaceRecognition {
    constructor() {
        this.embeddingsFile = path.join(__dirname, 'embeddings', 'gallery_embeddings.json');
        this.pythonPath = process.env.PYTHON_PATH || 'python3';
        this.threshold = parseFloat(process.env.FACE_RECOGNITION_THRESHOLD) || 0.6;
        this.model = process.env.FACE_RECOGNITION_MODEL || 'buffalo_l';
        this.tempDir = path.join(__dirname, '..', 'uploads', 'temp');
        
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    async extractFaceEmbedding(imageBuffer) {
        return new Promise((resolve, reject) => {
            const tempId = crypto.randomBytes(16).toString('hex');
            const tempPath = path.join(this.tempDir, `${tempId}.jpg`);
            
            try {
                fs.writeFileSync(tempPath, imageBuffer);
            } catch (err) {
                reject(new Error(`Failed to save temp image: ${err.message}`));
                return;
            }

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
                try { fs.unlinkSync(tempPath); } catch (err) {}

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

    async findMatchingPhotos(embedding) {
        return new Promise((resolve, reject) => {
            if (!fs.existsSync(this.embeddingsFile)) {
                reject(new Error('Gallery embeddings database not found. Please run extract_embeddings first.'));
                return;
            }

            const inputData = {
                embedding: embedding,
                threshold: this.threshold
            };

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

            pythonProcess.stdin.write(JSON.stringify(inputData));
            pythonProcess.stdin.end();
        });
    }

    async extractAllGalleryEmbeddings(imagesData) {
        return new Promise((resolve, reject) => {
            const tempId = crypto.randomBytes(16).toString('hex');
            const tempFile = path.join(this.tempDir, `${tempId}.json`);
            
            try {
                fs.writeFileSync(tempFile, JSON.stringify(imagesData));
            } catch (err) {
                reject(new Error(`Failed to save images data: ${err.message}`));
                return;
            }

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
                try { fs.unlinkSync(tempFile); } catch (err) {}

                if (code !== 0) {
                    reject(new Error(`Python script failed: ${stderr || stdout}`));
                    return;
                }

                resolve({ success: true, output: stdout });
            });
        });
    }

    hasEmbeddingsDatabase() {
        return fs.existsSync(this.embeddingsFile);
    }

    getDatabaseInfo() {
        if (!this.hasEmbeddingsDatabase()) return null;
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
