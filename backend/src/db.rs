use sqlx::postgres::{PgPool, PgPoolOptions};

pub async fn connect(url: &str) -> anyhow::Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(url)
        .await?;

    let sql = include_str!("../migrations.sql");
    sqlx::raw_sql(sql).execute(&pool).await?;

    Ok(pool)
}
