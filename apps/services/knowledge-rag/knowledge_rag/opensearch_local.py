from opensearchpy import OpenSearch


def create_local_opensearch_client() -> OpenSearch:
    return OpenSearch(
        hosts=[{"host": "localhost", "port": 9200}],
        use_ssl=False,
    )