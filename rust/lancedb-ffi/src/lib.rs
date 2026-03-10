use std::sync::Arc;

use arrow_array::{Array, FixedSizeListArray, Float32Array, Int64Array, RecordBatch, RecordBatchIterator, StringArray};
use arrow_schema::{DataType, Field, Schema};
use futures::TryStreamExt;
use lance_table::io::commit::UnsafeCommitHandler;
use lancedb::query::{ExecutableQuery, QueryBase};
use lancedb::table::{ReadParams, WriteOptions};
use lance::dataset::{WriteMode, WriteParams};
use once_cell::sync::Lazy;
use tokio::runtime::Runtime;

uniffi::setup_scaffolding!();

// Global tokio runtime — initialized once, lives for the process lifetime.
static RUNTIME: Lazy<Runtime> = Lazy::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("Failed to create tokio runtime")
});

// ---------------------------------------------------------------------------
// UniFFI-exported types
// ---------------------------------------------------------------------------

#[derive(uniffi::Record, Clone, Debug)]
pub struct SearchResult {
    pub key: String,
    pub text: String,
    pub score: f64,
    pub metadata: Option<String>,
}

#[derive(uniffi::Record, Clone, Debug)]
pub struct HybridSearchResult {
    pub key: String,
    pub text: String,
    pub vector_rank: u32,
    pub text_rank: u32,
    pub rrf_score: f64,
    pub metadata: Option<String>,
}

#[derive(uniffi::Error, Debug)]
pub enum LanceError {
    ConnectionFailed { msg: String },
    TableError { msg: String },
    QueryError { msg: String },
    InsertError { msg: String },
    DeleteError { msg: String },
    SchemaError { msg: String },
}

impl std::fmt::Display for LanceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LanceError::ConnectionFailed { msg } => write!(f, "ConnectionFailed: {msg}"),
            LanceError::TableError { msg } => write!(f, "TableError: {msg}"),
            LanceError::QueryError { msg } => write!(f, "QueryError: {msg}"),
            LanceError::InsertError { msg } => write!(f, "InsertError: {msg}"),
            LanceError::DeleteError { msg } => write!(f, "DeleteError: {msg}"),
            LanceError::SchemaError { msg } => write!(f, "SchemaError: {msg}"),
        }
    }
}

// ---------------------------------------------------------------------------
// LanceDBHandle — the main UniFFI object
// ---------------------------------------------------------------------------

const DEFAULT_TABLE: &str = "memories";

#[derive(uniffi::Object)]
pub struct LanceDBHandle {
    db_path: String,
    embedding_dim: i32,
}

fn make_schema(dim: i32) -> Schema {
    Schema::new(vec![
        Field::new("key", DataType::Utf8, false),
        Field::new("agent_id", DataType::Utf8, false),
        Field::new("text", DataType::Utf8, false),
        Field::new(
            "embedding",
            DataType::FixedSizeList(
                Arc::new(Field::new("item", DataType::Float32, true)),
                dim,
            ),
            false,
        ),
        Field::new("metadata", DataType::Utf8, true),
        Field::new("created_at", DataType::Int64, false),
    ])
}

#[uniffi::export(async_runtime = "tokio")]
impl LanceDBHandle {
    /// Open (or create) a LanceDB database at `db_path`.
    /// `embedding_dim` is the fixed vector dimension (e.g. 1536 for OpenAI ada-002).
    #[uniffi::constructor]
    pub async fn open(db_path: String, embedding_dim: i32) -> Result<Arc<Self>, LanceError> {
        if embedding_dim <= 0 {
            return Err(LanceError::SchemaError {
                msg: format!("embedding_dim must be > 0, got {embedding_dim}"),
            });
        }

        std::fs::create_dir_all(&db_path).map_err(|e| LanceError::ConnectionFailed {
            msg: format!("Cannot create db directory: {e}"),
        })?;

        // Verify we can connect
        let _db = lancedb::connect(&db_path)
            .execute()
            .await
            .map_err(|e| LanceError::ConnectionFailed {
                msg: e.to_string(),
            })?;

        Ok(Arc::new(Self {
            db_path,
            embedding_dim,
        }))
    }

    /// Store a memory entry. Overwrites if `key` already exists.
    pub async fn store(
        &self,
        key: String,
        agent_id: String,
        text: String,
        embedding: Vec<f32>,
        metadata: Option<String>,
    ) -> Result<(), LanceError> {
        if embedding.len() != self.embedding_dim as usize {
            return Err(LanceError::InsertError {
                msg: format!(
                    "embedding length {} != expected {}",
                    embedding.len(),
                    self.embedding_dim
                ),
            });
        }

        let db = self.connect().await?;
        let schema = Arc::new(make_schema(self.embedding_dim));

        // Delete existing entry with this key (upsert semantics)
        if let Ok(table) = self.open_table_unsafe(&db, DEFAULT_TABLE).await {
            let _ = table
                .delete(&format!("key = '{}'", key.replace('\'', "''")))
                .await;
        }

        let now = chrono_now_ms();
        let batch = self.make_batch(
            &schema,
            vec![key],
            vec![agent_id],
            vec![text],
            vec![embedding],
            vec![metadata],
            vec![now],
        )?;

        let batches = RecordBatchIterator::new(vec![Ok(batch)], schema.clone());

        // Create table if not exists, otherwise add to existing
        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| LanceError::TableError {
                msg: e.to_string(),
            })?;

        if tables.contains(&DEFAULT_TABLE.to_string()) {
            match self.open_table_unsafe(&db, DEFAULT_TABLE).await {
                Ok(table) => {
                    table
                        .add(batches)
                        .write_options(Self::unsafe_write_options(WriteMode::Append))
                        .execute()
                        .await
                        .map_err(|e| LanceError::InsertError {
                            msg: e.to_string(),
                        })?;
                }
                Err(_) => {
                    // Table is corrupted (e.g. partial write) — drop and recreate
                    let _ = db.drop_table(DEFAULT_TABLE, &[]).await;
                    db.create_table(DEFAULT_TABLE, batches)
                        .write_options(Self::unsafe_write_options(WriteMode::Create))
                        .execute()
                        .await
                        .map_err(|e| LanceError::TableError {
                            msg: e.to_string(),
                        })?;
                }
            }
        } else {
            db.create_table(DEFAULT_TABLE, batches)
                .write_options(Self::unsafe_write_options(WriteMode::Create))
                .execute()
                .await
                .map_err(|e| LanceError::TableError {
                    msg: e.to_string(),
                })?;
        }

        Ok(())
    }

    /// Search for the `limit` nearest neighbours to `query_vector`.
    /// Optional `filter` is a SQL-like predicate (e.g. `"agent_id = 'main'"`).
    pub async fn search(
        &self,
        query_vector: Vec<f32>,
        limit: u32,
        filter: Option<String>,
    ) -> Result<Vec<SearchResult>, LanceError> {
        if query_vector.len() != self.embedding_dim as usize {
            return Err(LanceError::QueryError {
                msg: format!(
                    "query_vector length {} != expected {}",
                    query_vector.len(),
                    self.embedding_dim
                ),
            });
        }

        let db = self.connect().await?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| LanceError::TableError {
                msg: e.to_string(),
            })?;

        if !tables.contains(&DEFAULT_TABLE.to_string()) {
            return Ok(vec![]);
        }

        let table = self.open_table_unsafe(&db, DEFAULT_TABLE).await?;

        let mut query = table
            .query()
            .nearest_to(query_vector)
            .map_err(|e| LanceError::QueryError {
                msg: e.to_string(),
            })?
            .limit(limit as usize);

        if let Some(ref f) = filter {
            query = query.only_if(f.clone());
        }

        let stream = query
            .execute()
            .await
            .map_err(|e| LanceError::QueryError {
                msg: e.to_string(),
            })?;

        let batches: Vec<RecordBatch> = stream
            .try_collect()
            .await
            .map_err(|e| LanceError::QueryError {
                msg: e.to_string(),
            })?;

        let mut results = Vec::new();
        for batch in &batches {
            let keys = batch
                .column_by_name("key")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>());
            let texts = batch
                .column_by_name("text")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>());
            let metas = batch
                .column_by_name("metadata")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>());
            let distances = batch
                .column_by_name("_distance")
                .and_then(|c| c.as_any().downcast_ref::<Float32Array>());

            let (keys, texts) = match (keys, texts) {
                (Some(k), Some(t)) => (k, t),
                _ => continue,
            };

            for i in 0..batch.num_rows() {
                let score = distances.map(|d| 1.0 - d.value(i) as f64).unwrap_or(0.0);
                let metadata = metas.and_then(|m| {
                    if m.is_null(i) {
                        None
                    } else {
                        Some(m.value(i).to_string())
                    }
                });
                results.push(SearchResult {
                    key: keys.value(i).to_string(),
                    text: texts.value(i).to_string(),
                    score,
                    metadata,
                });
            }
        }

        Ok(results)
    }

    /// Delete a memory entry by key.
    pub async fn delete(&self, key: String) -> Result<(), LanceError> {
        let db = self.connect().await?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| LanceError::TableError {
                msg: e.to_string(),
            })?;

        if !tables.contains(&DEFAULT_TABLE.to_string()) {
            return Ok(());
        }

        let table = self.open_table_unsafe(&db, DEFAULT_TABLE).await?;

        table
            .delete(&format!("key = '{}'", key.replace('\'', "''")))
            .await
            .map_err(|e| LanceError::DeleteError {
                msg: e.to_string(),
            })?;

        Ok(())
    }

    /// List memory keys, optionally filtered by prefix.
    pub async fn list(
        &self,
        prefix: Option<String>,
        limit: Option<u32>,
    ) -> Result<Vec<String>, LanceError> {
        let db = self.connect().await?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| LanceError::TableError {
                msg: e.to_string(),
            })?;

        if !tables.contains(&DEFAULT_TABLE.to_string()) {
            return Ok(vec![]);
        }

        let table = self.open_table_unsafe(&db, DEFAULT_TABLE).await?;

        let mut query = table.query()
            .select(lancedb::query::Select::Columns(vec!["key".to_string()]));

        if let Some(ref p) = prefix {
            query = query.only_if(format!("starts_with(key, '{}')", p.replace('\'', "''")));
        }

        if let Some(lim) = limit {
            query = query.limit(lim as usize);
        }

        let stream = query
            .execute()
            .await
            .map_err(|e| LanceError::QueryError {
                msg: e.to_string(),
            })?;

        let batches: Vec<RecordBatch> = stream
            .try_collect()
            .await
            .map_err(|e| LanceError::QueryError {
                msg: e.to_string(),
            })?;

        let mut keys = Vec::new();
        for batch in &batches {
            if let Some(arr) = batch
                .column_by_name("key")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            {
                for i in 0..arr.len() {
                    keys.push(arr.value(i).to_string());
                }
            }
        }

        Ok(keys)
    }

    /// Drop all data. If `collection` is None, drops the default table.
    pub async fn clear(&self, collection: Option<String>) -> Result<(), LanceError> {
        let db = self.connect().await?;
        let table_name = collection.as_deref().unwrap_or(DEFAULT_TABLE);

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| LanceError::TableError {
                msg: e.to_string(),
            })?;

        if tables.contains(&table_name.to_string()) {
            db.drop_table(table_name, &[])
                .await
                .map_err(|e| LanceError::TableError {
                    msg: e.to_string(),
                })?;
        }

        Ok(())
    }

    /// Hybrid search combining vector ANN and BM25 text scoring via RRF fusion.
    /// `query_vector`: embedding for ANN search.
    /// `query_text`: text query for BM25 scoring.
    /// `limit`: number of results to return.
    /// `filter`: optional SQL-like predicate.
    /// `rrf_k`: RRF constant (default 60).
    /// `vector_limit`: number of ANN candidates to over-fetch (default limit * 4).
    pub async fn hybrid_search(
        &self,
        query_vector: Vec<f32>,
        query_text: String,
        limit: u32,
        filter: Option<String>,
        rrf_k: Option<u32>,
        vector_limit: Option<u32>,
    ) -> Result<Vec<HybridSearchResult>, LanceError> {
        if query_vector.len() != self.embedding_dim as usize {
            return Err(LanceError::QueryError {
                msg: format!(
                    "query_vector length {} != expected {}",
                    query_vector.len(),
                    self.embedding_dim
                ),
            });
        }

        let db = self.connect().await?;

        let tables = db
            .table_names()
            .execute()
            .await
            .map_err(|e| LanceError::TableError {
                msg: e.to_string(),
            })?;

        if !tables.contains(&DEFAULT_TABLE.to_string()) {
            return Ok(vec![]);
        }

        let table = self.open_table_unsafe(&db, DEFAULT_TABLE).await?;

        let vlimit = vector_limit.unwrap_or(limit * 4) as usize;

        let mut query = table
            .query()
            .nearest_to(query_vector)
            .map_err(|e| LanceError::QueryError {
                msg: e.to_string(),
            })?
            .limit(vlimit);

        if let Some(ref f) = filter {
            query = query.only_if(f.clone());
        }

        let stream = query
            .execute()
            .await
            .map_err(|e| LanceError::QueryError {
                msg: e.to_string(),
            })?;

        let batches: Vec<RecordBatch> = stream
            .try_collect()
            .await
            .map_err(|e| LanceError::QueryError {
                msg: e.to_string(),
            })?;

        // Extract candidates from Arrow batches
        struct Candidate {
            key: String,
            text: String,
            distance: f64,
            metadata: Option<String>,
        }

        let mut candidates: Vec<Candidate> = Vec::new();
        for batch in &batches {
            let keys = batch
                .column_by_name("key")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>());
            let texts = batch
                .column_by_name("text")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>());
            let metas = batch
                .column_by_name("metadata")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>());
            let distances = batch
                .column_by_name("_distance")
                .and_then(|c| c.as_any().downcast_ref::<Float32Array>());

            let (keys, texts) = match (keys, texts) {
                (Some(k), Some(t)) => (k, t),
                _ => continue,
            };

            for i in 0..batch.num_rows() {
                let distance = distances.map(|d| d.value(i) as f64).unwrap_or(f64::MAX);
                let metadata = metas.and_then(|m| {
                    if m.is_null(i) {
                        None
                    } else {
                        Some(m.value(i).to_string())
                    }
                });
                candidates.push(Candidate {
                    key: keys.value(i).to_string(),
                    text: texts.value(i).to_string(),
                    distance,
                    metadata,
                });
            }
        }

        if candidates.is_empty() {
            return Ok(vec![]);
        }

        // Rank by vector distance (ascending = better)
        candidates.sort_by(|a, b| a.distance.partial_cmp(&b.distance).unwrap_or(std::cmp::Ordering::Equal));
        let vector_ranks: Vec<u32> = (0..candidates.len()).map(|i| (i + 1) as u32).collect();

        // Compute BM25 scores
        let doc_texts: Vec<String> = candidates.iter().map(|c| c.text.clone()).collect();
        let bm25 = bm25_scores(&doc_texts, &query_text);

        // Rank by BM25 score (descending = better)
        let mut bm25_indices: Vec<usize> = (0..candidates.len()).collect();
        bm25_indices.sort_by(|&a, &b| bm25[b].partial_cmp(&bm25[a]).unwrap_or(std::cmp::Ordering::Equal));
        let mut text_ranks = vec![0u32; candidates.len()];
        for (rank, &idx) in bm25_indices.iter().enumerate() {
            text_ranks[idx] = (rank + 1) as u32;
        }

        // RRF fusion
        let k = rrf_k.unwrap_or(60) as f64;
        let mut scored: Vec<(usize, f64)> = (0..candidates.len())
            .map(|i| {
                let rrf = 1.0 / (k + vector_ranks[i] as f64) + 1.0 / (k + text_ranks[i] as f64);
                (i, rrf)
            })
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit as usize);

        let results = scored
            .into_iter()
            .map(|(i, rrf_score)| HybridSearchResult {
                key: candidates[i].key.clone(),
                text: candidates[i].text.clone(),
                vector_rank: vector_ranks[i],
                text_rank: text_ranks[i],
                rrf_score,
                metadata: candidates[i].metadata.clone(),
            })
            .collect();

        Ok(results)
    }
}

// ---------------------------------------------------------------------------
// Private helpers (not exported via UniFFI)
// ---------------------------------------------------------------------------

impl LanceDBHandle {
    async fn connect(&self) -> Result<lancedb::Connection, LanceError> {
        lancedb::connect(&self.db_path)
            .execute()
            .await
            .map_err(|e| LanceError::ConnectionFailed {
                msg: e.to_string(),
            })
    }

    /// Open a table with UnsafeCommitHandler — avoids hardlink() syscall
    /// that Android SELinux blocks for untrusted_app processes.
    async fn open_table_unsafe(
        &self,
        db: &lancedb::Connection,
        name: &str,
    ) -> Result<lancedb::Table, LanceError> {
        let read_params = ReadParams {
            commit_handler: Some(Arc::new(UnsafeCommitHandler)),
            ..Default::default()
        };
        db.open_table(name)
            .lance_read_params(read_params)
            .execute()
            .await
            .map_err(|e| LanceError::TableError {
                msg: e.to_string(),
            })
    }

    fn unsafe_write_options(mode: WriteMode) -> WriteOptions {
        WriteOptions {
            lance_write_params: Some(WriteParams {
                mode,
                commit_handler: Some(Arc::new(UnsafeCommitHandler)),
                ..Default::default()
            }),
        }
    }

    fn make_batch(
        &self,
        schema: &Arc<Schema>,
        keys: Vec<String>,
        agent_ids: Vec<String>,
        texts: Vec<String>,
        embeddings: Vec<Vec<f32>>,
        metadatas: Vec<Option<String>>,
        created_ats: Vec<i64>,
    ) -> Result<RecordBatch, LanceError> {
        // Flatten embeddings into a single Vec<f32>
        let flat: Vec<f32> = embeddings.iter().flatten().copied().collect();
        let values = Float32Array::from(flat);

        let field = Arc::new(Field::new("item", DataType::Float32, true));
        let embedding_array =
            FixedSizeListArray::new(field, self.embedding_dim, Arc::new(values), None);

        let key_array = StringArray::from(keys);
        let agent_id_array = StringArray::from(agent_ids);
        let text_array = StringArray::from(texts);
        let metadata_array = StringArray::from(
            metadatas
                .into_iter()
                .collect::<Vec<Option<String>>>(),
        );
        let created_at_array = Int64Array::from(created_ats);

        RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(key_array),
                Arc::new(agent_id_array),
                Arc::new(text_array),
                Arc::new(embedding_array),
                Arc::new(metadata_array),
                Arc::new(created_at_array),
            ],
        )
        .map_err(|e| LanceError::InsertError {
            msg: format!("Failed to create record batch: {e}"),
        })
    }
}

// ---------------------------------------------------------------------------
// BM25 scoring helpers (pure Rust, no external deps)
// ---------------------------------------------------------------------------

fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

fn bm25_scores(docs: &[String], query: &str) -> Vec<f64> {
    let k1 = 1.2_f64;
    let b = 0.75_f64;
    let query_terms = tokenize(query);
    let doc_tokens: Vec<Vec<String>> = docs.iter().map(|d| tokenize(d)).collect();
    let n = docs.len() as f64;
    let avgdl = doc_tokens.iter().map(|t| t.len() as f64).sum::<f64>() / n.max(1.0);

    doc_tokens
        .iter()
        .map(|tokens| {
            let dl = tokens.len() as f64;
            query_terms
                .iter()
                .map(|term| {
                    let tf = tokens.iter().filter(|t| *t == term).count() as f64;
                    let df = doc_tokens.iter().filter(|dt| dt.contains(term)).count() as f64;
                    let idf = ((n - df + 0.5) / (df + 0.5) + 1.0).ln();
                    idf * (tf * (k1 + 1.0)) / (tf + k1 * (1.0 - b + b * dl / avgdl))
                })
                .sum()
        })
        .collect()
}

fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_store_and_search() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().to_str().unwrap().to_string();

        let handle = LanceDBHandle::open(db_path, 4).await.unwrap();

        handle
            .store(
                "color-blue".into(),
                "main".into(),
                "My favorite color is blue".into(),
                vec![1.0, 0.0, 0.0, 0.0],
                None,
            )
            .await
            .unwrap();

        handle
            .store(
                "color-red".into(),
                "main".into(),
                "I also like red".into(),
                vec![0.9, 0.1, 0.0, 0.0],
                None,
            )
            .await
            .unwrap();

        handle
            .store(
                "food-pizza".into(),
                "main".into(),
                "I love pizza".into(),
                vec![0.0, 0.0, 1.0, 0.0],
                None,
            )
            .await
            .unwrap();

        let results = handle
            .search(vec![1.0, 0.0, 0.0, 0.0], 2, None)
            .await
            .unwrap();

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].key, "color-blue");
        assert_eq!(results[1].key, "color-red");
    }

    #[tokio::test]
    async fn test_delete() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().to_str().unwrap().to_string();

        let handle = LanceDBHandle::open(db_path, 4).await.unwrap();

        handle
            .store(
                "k1".into(),
                "main".into(),
                "text1".into(),
                vec![1.0, 0.0, 0.0, 0.0],
                None,
            )
            .await
            .unwrap();

        let keys = handle.list(None, None).await.unwrap();
        assert_eq!(keys.len(), 1);

        handle.delete("k1".into()).await.unwrap();

        let keys = handle.list(None, None).await.unwrap();
        assert_eq!(keys.len(), 0);
    }

    #[tokio::test]
    async fn test_list_with_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().to_str().unwrap().to_string();

        let handle = LanceDBHandle::open(db_path, 4).await.unwrap();

        for (k, text) in [("proj:a", "A"), ("proj:b", "B"), ("other:c", "C")] {
            handle
                .store(
                    k.into(),
                    "main".into(),
                    text.into(),
                    vec![1.0, 0.0, 0.0, 0.0],
                    None,
                )
                .await
                .unwrap();
        }

        let proj_keys = handle.list(Some("proj:".into()), None).await.unwrap();
        assert_eq!(proj_keys.len(), 2);

        let all_keys = handle.list(None, None).await.unwrap();
        assert_eq!(all_keys.len(), 3);
    }

    #[tokio::test]
    async fn test_clear() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().to_str().unwrap().to_string();

        let handle = LanceDBHandle::open(db_path, 4).await.unwrap();

        handle
            .store(
                "k1".into(),
                "main".into(),
                "text".into(),
                vec![1.0, 0.0, 0.0, 0.0],
                None,
            )
            .await
            .unwrap();

        handle.clear(None).await.unwrap();

        let keys = handle.list(None, None).await.unwrap();
        assert_eq!(keys.len(), 0);
    }

    #[tokio::test]
    async fn test_upsert() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().to_str().unwrap().to_string();

        let handle = LanceDBHandle::open(db_path, 4).await.unwrap();

        handle
            .store(
                "k1".into(),
                "main".into(),
                "original".into(),
                vec![1.0, 0.0, 0.0, 0.0],
                None,
            )
            .await
            .unwrap();

        handle
            .store(
                "k1".into(),
                "main".into(),
                "updated".into(),
                vec![0.0, 1.0, 0.0, 0.0],
                None,
            )
            .await
            .unwrap();

        let keys = handle.list(None, None).await.unwrap();
        assert_eq!(keys.len(), 1);

        let results = handle
            .search(vec![0.0, 1.0, 0.0, 0.0], 1, None)
            .await
            .unwrap();
        assert_eq!(results[0].text, "updated");
    }

    #[test]
    fn test_bm25_scores() {
        let docs = vec![
            "the quick brown fox jumps over the lazy dog".to_string(),
            "a lazy cat sleeps all day".to_string(),
            "the fox is quick and brown".to_string(),
        ];
        let scores = bm25_scores(&docs, "quick brown fox");

        // Doc 0 has all three query terms → highest score
        // Doc 2 has all three query terms too but is shorter → also high
        // Doc 1 has none of the query terms → score ~0
        assert!(scores[0] > scores[1], "doc0 ({}) should beat doc1 ({})", scores[0], scores[1]);
        assert!(scores[2] > scores[1], "doc2 ({}) should beat doc1 ({})", scores[2], scores[1]);
        assert!(scores[1].abs() < 1e-9, "doc1 should have ~0 score, got {}", scores[1]);
    }

    #[test]
    fn test_rrf_fusion() {
        // Simulate 3 candidates with known vector and text ranks
        let k = 60.0_f64;

        // Candidate A: vector_rank=1, text_rank=3
        let rrf_a = 1.0 / (k + 1.0) + 1.0 / (k + 3.0);
        // Candidate B: vector_rank=3, text_rank=1
        let rrf_b = 1.0 / (k + 3.0) + 1.0 / (k + 1.0);
        // Candidate C: vector_rank=2, text_rank=2
        let rrf_c = 1.0 / (k + 2.0) + 1.0 / (k + 2.0);

        // A and B should have the same RRF score (symmetric formula)
        assert!(
            (rrf_a - rrf_b).abs() < 1e-12,
            "symmetric ranks should give equal RRF: {} vs {}",
            rrf_a,
            rrf_b
        );

        // A (rank 1,3) slightly beats C (rank 2,2) because 1/(61)+1/(63) > 2/(62)
        // (harmonic mean property: the lower rank gains more than the higher rank loses)
        assert!(
            rrf_a > rrf_c,
            "skewed ranks should slightly beat balanced: {} vs {}",
            rrf_a,
            rrf_c
        );

        // Verify actual values
        let expected_c = 2.0 / 62.0;
        assert!(
            (rrf_c - expected_c).abs() < 1e-12,
            "rrf_c should be 2/62 = {}, got {}",
            expected_c,
            rrf_c
        );
    }
}
