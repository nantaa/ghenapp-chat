package upload

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/ghenapp/ghenapp/internal/auth"
	"github.com/ghenapp/ghenapp/internal/db"
	"github.com/google/uuid"
)

// Handler manages file uploads and serving.
type Handler struct {
	queries    *db.Queries
	uploadPath string
	maxBytes   int64
}

func NewHandler(q *db.Queries, uploadPath string, maxBytes int64) *Handler {
	return &Handler{queries: q, uploadPath: uploadPath, maxBytes: maxBytes}
}

// RegisterRoutes wires upload routes.
func (h *Handler) RegisterRoutes(rg *gin.RouterGroup, authMiddleware gin.HandlerFunc) {
	rg.POST("/upload", authMiddleware, h.Upload)
	rg.GET("/files/:id", authMiddleware, h.ServeFile)
}

// Upload handles multipart file upload.
// Server-side enforces the 2MB hard limit.
func (h *Handler) Upload(c *gin.Context) {
	userID := auth.GetUserID(c)

	// Limit request body to maxBytes + small multipart overhead
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, h.maxBytes+4096)

	file, header, err := c.Request.FormFile("file")
	if err != nil {
		if err.Error() == "http: request body too large" {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": fmt.Sprintf("file exceeds %d bytes limit", h.maxBytes)})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file upload: " + err.Error()})
		return
	}
	defer file.Close()

	// Double-check size server-side
	if header.Size > h.maxBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": fmt.Sprintf("file size %d exceeds %d byte limit", header.Size, h.maxBytes)})
		return
	}

	// Detect MIME type
	buf := make([]byte, 512)
	n, _ := file.Read(buf)
	mimeType := http.DetectContentType(buf[:n])
	file.Seek(0, io.SeekStart)

	// Store with UUID filename to prevent path traversal
	fileID := uuid.New()
	ext := filepath.Ext(header.Filename)
	storageName := fileID.String() + ext
	storagePath := filepath.Join(h.uploadPath, storageName)

	dst, err := os.Create(storagePath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to store file"})
		return
	}
	defer dst.Close()

	written, err := io.Copy(dst, file)
	if err != nil || written != header.Size {
		os.Remove(storagePath)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to write file"})
		return
	}

	uid, _ := uuid.Parse(userID)
	record, err := h.queries.CreateUpload(c.Request.Context(), db.CreateUploadParams{
		UploaderID:  uid,
		Filename:    header.Filename,
		MimeType:    mimeType,
		SizeBytes:   int32(header.Size),
		StoragePath: storagePath,
	})
	if err != nil {
		os.Remove(storagePath)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to record upload"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"id":        record.ID,
		"filename":  header.Filename,
		"mime_type": mimeType,
		"size":      header.Size,
		"url":       fmt.Sprintf("/api/v1/files/%s", record.ID),
	})
}

// ServeFile serves a previously uploaded file. Auth-gated.
func (h *Handler) ServeFile(c *gin.Context) {
	idStr := c.Param("id")
	fileID, err := uuid.Parse(idStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file id"})
		return
	}

	record, err := h.queries.GetUploadByID(c.Request.Context(), fileID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}

	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, record.Filename))
	c.Header("Content-Type", record.MimeType)
	c.Header("Cache-Control", "private, max-age=86400")
	http.ServeFile(c.Writer, c.Request, record.StoragePath)
}
