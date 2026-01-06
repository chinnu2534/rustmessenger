# Build stage
FROM rust:latest as builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y \
    libsqlite3-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Copy everything needed for build
COPY Cargo.toml Cargo.lock* ./
COPY src ./src

# Create db directory and empty database for sqlx compile-time checks
RUN mkdir -p db

# Build release binary
RUN cargo build --release

# Runtime stage
FROM debian:bookworm-slim

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    libsqlite3-0 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy binary from builder
COPY --from=builder /app/target/release/chat_app /app/chat_app

# Copy static files
COPY static ./static

# Create db directory for runtime with write permissions
RUN mkdir -p db && chmod 777 db

# Expose port
EXPOSE 3030

# Set environment variables
ENV RUST_LOG=info

# Run the application
CMD ["./chat_app"]
